/**
 * Recording module — voice capture, audio mixing, speaker tracking.
 */

const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { Transform } = require('stream');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');
const { makeEmbed, postCommandDictionary, formatDuration } = require('./discord-utils');

// ─── State per guild ────────────────────────────────────────────────
/** @type {Map<string, RecordingSession>} */
const sessions = new Map();

class RecordingSession {
  constructor(guildId, textChannel, mode = 'standard') {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.connection = null;
    this.userStreams = new Map();      // Map<userId, PassThrough>
    this.pcmFiles = [];                // temp per-user PCM paths
    this.startTime = null;
    this.outputPath = '';
    this.active = false;
    this.mode = mode;                  // 'standard' or 'oneshot'
    // ── Speaker tracking ──────────────────────────────────────────
    this.speakingSegments = [];        // Array<{ userId, startTime, endTime }>
    this.currentlySpeaking = new Map(); // Map<userId, startTime> for users currently speaking
    this.speakerDisplayNames = new Map(); // Map<userId, displayName>
    // ── Character switch markers ──────────────────────────────────
    this.characterSwitches = [];       // Array<{ userId, timestamp, newCharacter }>
  }
}

// ─── Silence padding transform ─────────────────────────────────────
// Discord only sends Opus packets during speech (voice-activity detection).
// Without padding, the decoded PCM files contain all speech segments
// concatenated back-to-back — a 2-hour session could collapse to 30 minutes.
// This transform inserts zero-filled (silent) PCM between speech bursts so
// the resulting file reflects real wall-clock timing.

class SilencePadTransform extends Transform {
  /**
   * @param {number} sessionStartTime  Date.now() when recording began
   * @param {number} sampleRate        e.g. 48000
   * @param {number} channels          e.g. 2
   */
  constructor(sessionStartTime, sampleRate = 48000, channels = 2) {
    super();
    this.sessionStartTime = sessionStartTime;
    // bytes per millisecond of 16-bit PCM at the given rate / channels
    this.bytesPerMs = (sampleRate * channels * 2) / 1000;
    this.lastChunkTime = null;
    this.firstChunk = true;
    // Only pad gaps longer than this (avoids micro-jitter between frames)
    this.SILENCE_THRESHOLD_MS = 200;
    // Cap a single silence insert at 60 seconds to avoid runaway allocation
    this.MAX_SILENCE_MS = 60_000;
  }

  _transform(chunk, _encoding, callback) {
    const now = Date.now();

    if (this.firstChunk) {
      // Pad from session start to when this user first spoke
      this.firstChunk = false;
      const offsetMs = now - this.sessionStartTime;
      if (offsetMs > this.SILENCE_THRESHOLD_MS) {
        const padMs = Math.min(offsetMs, this.MAX_SILENCE_MS);
        const silenceBytes = Math.floor(padMs * this.bytesPerMs);
        if (silenceBytes > 0) {
          this.push(Buffer.alloc(silenceBytes, 0));
        }
      }
    } else if (this.lastChunkTime !== null) {
      const gapMs = now - this.lastChunkTime;
      if (gapMs > this.SILENCE_THRESHOLD_MS) {
        // Subtract one Opus frame (~20 ms) to avoid double-counting
        const padMs = Math.min(gapMs - 20, this.MAX_SILENCE_MS);
        const silenceBytes = Math.floor(padMs * this.bytesPerMs);
        if (silenceBytes > 0) {
          this.push(Buffer.alloc(silenceBytes, 0));
        }
      }
    }

    this.lastChunkTime = now;
    this.push(chunk);
    callback();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function sessionDateString() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Find the most recent speakers.json file in the recordings directory.
 */
function findLatestSpeakersFile() {
  try {
    const dir = config.paths.recordings;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('-speakers.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    return files.length > 0 ? path.join(dir, files[0].name) : null;
  } catch { return null; }
}

function sessionFileName() {
  const ext = config.audio.format === 'pcm' ? 'pcm' : 'ogg';
  return `session-${sessionDateString()}.${ext}`;
}

/**
 * Subscribe to a single user's audio stream coming from the voice receiver.
 */
function subscribeUser(session, receiver, userId) {
  if (session.userStreams.has(userId)) return;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const decoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  // Insert silence for gaps so the PCM file reflects wall-clock timing
  const silencePad = new SilencePadTransform(session.startTime, 48000, 2);

  const pcmPath = path.join(
    config.paths.recordings,
    `_tmp_${session.guildId}_${userId}_${Date.now()}.pcm`
  );
  const fileStream = fs.createWriteStream(pcmPath);
  session.pcmFiles.push(pcmPath);

  // ── Error handlers: survive corrupted Opus packets & stream errors ──
  opusStream.on('error', (err) => {
    log.warn('Opus stream error (skipped)', { userId, error: err.message });
  });

  decoder.on('error', (err) => {
    log.warn('Decoder error — corrupted packet skipped', { userId, error: err.message });
  });

  silencePad.on('error', (err) => {
    log.warn('SilencePad stream error (skipped)', { userId, error: err.message });
  });

  fileStream.on('error', (err) => {
    log.error('File write stream error', { userId, pcmPath, error: err.message });
  });

  // Use manual piping with error forwarding so a decoder error doesn't
  // take down the whole pipeline — errors are caught above and the stream
  // continues processing subsequent packets.
  opusStream.pipe(decoder).pipe(silencePad).pipe(fileStream);

  session.userStreams.set(userId, { opusStream, decoder, silencePad, fileStream, pcmPath });
  log.debug(`Subscribed to user audio`, { userId, pcmPath });
}

/**
 * Mix all per-user PCM files into a single output file using ffmpeg.
 */
async function mixAndEncode(session) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(config.paths.recordings, sessionFileName());
    session.outputPath = outPath;

    const validFiles = session.pcmFiles.filter(f => {
      try {
        return fs.statSync(f).size > 0;
      } catch { return false; }
    });

    if (validFiles.length === 0) {
      return reject(new Error('No audio data was captured.'));
    }

    // Build ffmpeg args: take each PCM as raw s16le input, amix them, encode
    const args = [];
    for (const f of validFiles) {
      args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', f);
    }

    if (validFiles.length > 1) {
      args.push(
        '-filter_complex',
        `amix=inputs=${validFiles.length}:duration=longest:dropout_transition=2`
      );
    }

    if (config.audio.format === 'pcm') {
      args.push('-f', 's16le', outPath);
    } else {
      // Encode to OGG Opus
      args.push('-c:a', 'libopus', '-b:a', '96k', outPath);
    }

    args.push('-y'); // overwrite

    log.info('Mixing audio with ffmpeg', { inputs: validFiles.length, output: outPath });
    const ff = spawn(config.audio.ffmpegPath, args);

    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('close', code => {
      // Clean up temp files
      for (const f of session.pcmFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
      if (code === 0) {
        log.info('Audio mixed successfully', { path: outPath });
        resolve(outPath);
      } else {
        log.error('ffmpeg failed', { code, stderr: stderr.slice(-500) });
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ff.on('error', err => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

// ─── Core record / stop logic ───────────────────────────────────────

/**
 * Start recording a voice channel.
 * @param {string} guildId
 * @param {VoiceChannel} voiceChannel
 * @param {TextChannel} textChannel
 * @param {string} mode - 'standard' or 'oneshot'
 * @param {string} clientUserId - The bot's own user ID (to skip self)
 */
async function startRecording(guildId, voiceChannel, textChannel, mode = 'standard', clientUserId) {
  if (sessions.has(guildId)) {
    return { success: false, message: 'Already recording in this server. Use `!stop` first.' };
  }

  const session = new RecordingSession(guildId, textChannel, mode);
  sessions.set(guildId, session);

  try {
    // Destroy any lingering connection for this guild before creating a new one
    const existingConnection = getVoiceConnection(guildId);
    if (existingConnection) {
      try { existingConnection.destroy(); } catch { /* ignore */ }
      // Brief pause to let the old connection clean up
      await new Promise(r => setTimeout(r, 1000));
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      debug: true,
    });

    session.connection = connection;

    // ── Connection state handlers ──────────────────────────────────
    connection.on('stateChange', (oldState, newState) => {
      log.debug('Voice connection state change', {
        guildId,
        from: oldState.status,
        to: newState.status,
      });
    });

    connection.on('error', err => {
      log.error('Voice connection error', { guildId, error: err.message });
    });

    // Handle unexpected disconnections — attempt to reconnect
    connection.on('stateChange', async (_, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        try {
          // Try to reconnect — Discord sometimes drops the UDP/WS connection
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Re-entering Signalling or Connecting means Discord is recovering
          log.info('Voice connection recovering from disconnect', { guildId });
        } catch {
          // If we can't re-enter Signalling/Connecting, the disconnect is final
          log.warn('Voice connection disconnected permanently', { guildId });
          if (session.active) {
            connection.destroy();
            session.active = false;
            try {
              session.textChannel.send({
                embeds: [makeEmbed('Disconnected', 'Lost voice connection. Recording stopped.', false)],
              });
            } catch { /* ignore */ }
          }
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        // Clean up the session if the connection was destroyed
        sessions.delete(guildId);
      }
    });

    // Wait until the connection is ready (60s timeout — the default 20s is
    // too short on slower networks or when Discord's voice servers are busy)
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);

    session.startTime = Date.now();
    session.active = true;

    const receiver = connection.receiver;

    // Subscribe to users already in the channel (skip bots like music bots)
    for (const [userId, member] of voiceChannel.members) {
      if (userId === clientUserId) continue;
      if (member.user.bot) continue; // Skip bots (music bots, etc.)
      subscribeUser(session, receiver, userId);
    }

    // Subscribe to anyone who starts speaking later (skip bots)
    receiver.speaking.on('start', userId => {
      if (!session.active) return;
      // Look up the member to check if they're a bot
      const member = voiceChannel.members.get(userId);
      if (member && member.user.bot) return; // Skip bots (music bots, etc.)
      subscribeUser(session, receiver, userId);

      // ── Speaker tracking: log start of speech ──────────────────
      if (!session.currentlySpeaking.has(userId)) {
        session.currentlySpeaking.set(userId, Date.now());
      }
      // Record display name for this user
      if (member && !session.speakerDisplayNames.has(userId)) {
        session.speakerDisplayNames.set(userId, member.displayName || member.user.username);
      }
    });

    // ── Speaker tracking: log end of speech ────────────────────────
    receiver.speaking.on('end', userId => {
      if (!session.active) return;
      const startTime = session.currentlySpeaking.get(userId);
      if (startTime) {
        session.speakingSegments.push({
          userId,
          startTime,
          endTime: Date.now(),
        });
        session.currentlySpeaking.delete(userId);
      }
    });

    log.info('Recording started', { guildId, channel: voiceChannel.name, mode });

    // Post the command dictionary once when joining a voice channel for recording
    postCommandDictionary(textChannel).catch(err => {
      log.warn('Failed to post command dictionary on record start', { error: err.message });
    });

    const modeLabel = mode === 'oneshot' ? ' (one-shot mode)' : '';
    return {
      success: true,
      message: `Recording started in **${voiceChannel.name}**${modeLabel}. Say \`!stop\` or \`/stop\` when the session is over.`,
    };
  } catch (err) {
    // Clean up on failure
    try { session.connection?.destroy(); } catch { /* ignore */ }
    sessions.delete(guildId);
    log.error('Failed to start recording', { error: err.message, stack: err.stack });
    return { success: false, message: `Failed to join voice channel: ${err.message}` };
  }
}

async function stopRecording(guildId) {
  const session = sessions.get(guildId);
  if (!session || !session.active) {
    return { success: false, message: 'Not currently recording.' };
  }

  session.active = false;

  // Gracefully close all user streams and wait for files to flush.
  // IMPORTANT: We must NOT destroy() the opusStream/decoder immediately —
  // that discards buffered data and truncates the recording. Instead,
  // end the decoder (which flushes its buffer through silencePad into
  // fileStream), wait for each fileStream to finish writing, then clean
  // up the opus source.
  const flushPromises = [];
  for (const [, { opusStream, decoder, silencePad, fileStream }] of session.userStreams) {
    flushPromises.push(new Promise((resolve) => {
      fileStream.on('finish', resolve);
      // Safety timeout — don't hang forever if a stream misbehaves
      const timeout = setTimeout(() => {
        log.warn('File stream flush timed out, continuing anyway');
        resolve();
      }, 10_000);
      fileStream.on('finish', () => clearTimeout(timeout));

      // Signal end-of-data through the pipeline:
      // unpipe the opus source, then end the decoder so it flushes
      // through silencePad → fileStream
      try { opusStream.unpipe(decoder); } catch { /* ignore */ }
      try { decoder.end(); } catch { /* ignore */ }
    }));
  }

  await Promise.all(flushPromises);

  // Now safe to destroy the opus streams (cleanup)
  for (const [, { opusStream }] of session.userStreams) {
    try { opusStream.destroy(); } catch { /* ignore */ }
  }

  // Disconnect from voice
  try {
    session.connection?.destroy();
  } catch { /* ignore */ }

  // ── Flush any still-speaking users into segments ─────────────────
  for (const [userId, startTime] of session.currentlySpeaking) {
    session.speakingSegments.push({ userId, startTime, endTime: Date.now() });
  }
  session.currentlySpeaking.clear();

  // ── Save speaker segments and display name map ─────────────────
  const speakersFile = path.join(
    config.paths.recordings,
    `session-${sessionDateString()}-speakers.json`
  );
  const speakerData = {
    sessionStart: session.startTime,
    segments: session.speakingSegments,
    users: Object.fromEntries(session.speakerDisplayNames),
    characterSwitches: session.characterSwitches,
    mode: session.mode,
  };
  try {
    fs.writeFileSync(speakersFile, JSON.stringify(speakerData, null, 2), 'utf-8');
    log.info('Speaker tracking data saved', { path: speakersFile, segments: session.speakingSegments.length });
  } catch (err) {
    log.warn('Failed to save speaker tracking data', { error: err.message });
  }

  const duration = Math.round((Date.now() - session.startTime) / 1000);
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;

  try {
    const outPath = await mixAndEncode(session);
    const fileSize = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    sessions.delete(guildId);
    log.info('Recording stopped', { guildId, duration, outPath });

    return {
      success: true,
      audioPath: outPath,
      mode: session.mode,
      message: `Recording saved! **${minutes}m ${seconds}s** captured. Processing...`,
    };
  } catch (err) {
    sessions.delete(guildId);
    log.error('Failed to save recording', { error: err.message });
    return { success: false, message: `Recording stopped but failed to save: ${err.message}` };
  }
}

// ─── Character switch helper ────────────────────────────────────────

/**
 * Handle the !switchchar / /switchchar logic.
 */
function handleSwitchChar(guildId, userId, displayName, newCharacter) {
  const session = sessions.get(guildId);
  if (!session || !session.active) {
    return { success: false, message: 'No active recording session. Start one with `!record` first.' };
  }

  if (!newCharacter || !newCharacter.trim()) {
    return { success: false, message: 'Usage: `!switchchar CharacterName`' };
  }

  const timestamp = Date.now();
  const elapsedMs = timestamp - session.startTime;

  session.characterSwitches.push({
    userId,
    timestamp,
    newCharacter: newCharacter.trim(),
  });

  // Update speaker-map.json with the new character name
  const speakerMapPath = path.join(config.paths.lore, 'speaker-map.json');
  try {
    let speakerMap = { users: {} };
    if (fs.existsSync(speakerMapPath)) {
      speakerMap = JSON.parse(fs.readFileSync(speakerMapPath, 'utf-8'));
    }
    speakerMap.users[userId] = {
      displayName: displayName,
      characterName: newCharacter.trim(),
    };
    fs.writeFileSync(speakerMapPath, JSON.stringify(speakerMap, null, 2), 'utf-8');
    log.info('Speaker map updated for character switch', { userId, newCharacter: newCharacter.trim() });
  } catch (err) {
    log.warn('Failed to update speaker-map.json for character switch', { error: err.message });
  }

  const timeStr = formatDuration(elapsedMs);
  log.info('Character switch recorded', { userId, displayName, newCharacter: newCharacter.trim(), elapsed: timeStr });

  return {
    success: true,
    message: `**${displayName}** switched to **${newCharacter.trim()}** at ${timeStr}`,
  };
}

module.exports = {
  sessions,
  RecordingSession,
  SilencePadTransform,
  startRecording,
  stopRecording,
  handleSwitchChar,
  findLatestSpeakersFile,
};
