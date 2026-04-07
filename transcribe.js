#!/usr/bin/env node
/**
 * D&D Scribe Bot — Transcription Pipeline
 *
 * Converts a recorded audio file into a timestamped, speaker-labelled
 * transcript.  Supports three backends:
 *
 *   whisper-local  — OpenAI Whisper (Python) or whisper.cpp, runs locally
 *   assemblyai     — AssemblyAI cloud API with speaker diarization
 *   deepgram       — Deepgram Nova-2 cloud API with diarization
 *
 * Usage:
 *   node transcribe.js ./recordings/session-2026-04-01.ogg
 *   node transcribe.js --latest
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const config = require('./config');
const log = require('./logger');

// ─── Speaker Map Utilities ─────────────────────────────────────────

/**
 * Load the speaker-map.json file that maps Discord user IDs to character names.
 * @returns {{ users: Object<string, { displayName: string, characterName: string }> }}
 */
function loadSpeakerMap() {
  const mapPath = path.join(config.paths.lore, 'speaker-map.json');
  if (!fs.existsSync(mapPath)) return { users: {} };
  try {
    return JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  } catch (err) {
    log.warn('Failed to load speaker-map.json', { error: err.message });
    return { users: {} };
  }
}

/**
 * Load the latest session speakers file (recorded speaking timestamps from Discord).
 * @returns {{ sessionStart: number, segments: Array, users: Object<string, string> } | null}
 */
function loadSessionSpeakers() {
  try {
    const dir = config.paths.recordings;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('-speakers.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[0].name), 'utf-8'));
  } catch (err) {
    log.warn('Failed to load session speakers file', { error: err.message });
    return null;
  }
}

/**
 * Match an AssemblyAI/Deepgram speaker label (e.g. "Speaker A") to a Discord user ID
 * by comparing the transcript utterance timestamps against recorded speaking segments.
 *
 * For each speaker label, finds which Discord user had the most overlapping speaking
 * time during the transcript segments attributed to that label.
 *
 * @param {Array<{ speaker: string, start: number, end: number }>} utterances  Transcript utterances with ms timestamps
 * @param {{ sessionStart: number, segments: Array<{ userId: string, startTime: number, endTime: number }>, users: Object }} sessionData
 * @returns {Object<string, string>}  Map of speaker label → Discord user ID
 */
function matchSpeakersToUsers(utterances, sessionData) {
  if (!sessionData || !sessionData.segments || sessionData.segments.length === 0) return {};

  const sessionStart = sessionData.sessionStart;

  // Group utterances by speaker label
  const speakerUtterances = {};
  for (const u of utterances) {
    if (!speakerUtterances[u.speaker]) speakerUtterances[u.speaker] = [];
    speakerUtterances[u.speaker].push(u);
  }

  const speakerToUser = {};

  for (const [speakerLabel, utts] of Object.entries(speakerUtterances)) {
    // For each utterance, compute overlap with each user's speaking segments
    const userOverlap = {};

    for (const utt of utts) {
      // Convert transcript timestamps (ms from start of audio) to absolute wall-clock ms
      const uttStart = sessionStart + utt.start;
      const uttEnd = sessionStart + utt.end;

      for (const seg of sessionData.segments) {
        const overlapStart = Math.max(uttStart, seg.startTime);
        const overlapEnd = Math.min(uttEnd, seg.endTime);
        if (overlapEnd > overlapStart) {
          if (!userOverlap[seg.userId]) userOverlap[seg.userId] = 0;
          userOverlap[seg.userId] += (overlapEnd - overlapStart);
        }
      }
    }

    // Pick the user with the most overlap
    let bestUser = null;
    let bestOverlap = 0;
    for (const [userId, overlap] of Object.entries(userOverlap)) {
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestUser = userId;
      }
    }

    if (bestUser) {
      speakerToUser[speakerLabel] = bestUser;
    }
  }

  return speakerToUser;
}

/**
 * Replace generic speaker labels in a transcript with "PlayerName (CharacterName):" format.
 * Falls back to Discord display name if no character mapping exists.
 * Handles character switches: if a user switched characters mid-session, the label
 * changes at the switch timestamp (e.g. "Sam (Breme):" before, "Sam (Thrain):" after).
 * Notifies about unmapped users and auto-maps single new users.
 *
 * @param {string} transcript  The raw transcript text
 * @param {Object<string, string>} speakerToUser  Map of speaker label → Discord user ID
 * @param {{ users: Object }} speakerMap  The speaker-map.json data
 * @param {{ users: Object<string, string>, characterSwitches?: Array, sessionStart?: number }} sessionData  Session data with display names
 * @returns {{ transcript: string, unmappedUsers: Array<{ userId: string, displayName: string }> }}
 */
function applySpeakerLabels(transcript, speakerToUser, speakerMap, sessionData) {
  const unmappedUsers = [];
  const labelReplacements = {};

  // Build character switch timeline per user (sorted by timestamp)
  const characterSwitches = sessionData?.characterSwitches || [];
  const switchesByUser = {};
  for (const sw of characterSwitches) {
    if (!switchesByUser[sw.userId]) switchesByUser[sw.userId] = [];
    switchesByUser[sw.userId].push(sw);
  }
  for (const userId of Object.keys(switchesByUser)) {
    switchesByUser[userId].sort((a, b) => a.timestamp - b.timestamp);
  }

  // Check if any user in this transcript has character switches
  const hasCharSwitches = characterSwitches.length > 0;

  for (const [label, userId] of Object.entries(speakerToUser)) {
    const mapping = speakerMap.users[userId];
    if (mapping) {
      const playerName = mapping.displayName;
      const charName = mapping.characterName;
      labelReplacements[label] = playerName !== charName
        ? `${playerName} (${charName})`
        : charName;
    } else {
      const displayName = sessionData?.users?.[userId] || `User_${userId.slice(-4)}`;
      labelReplacements[label] = displayName;
      unmappedUsers.push({ userId, displayName });
    }
  }

  // Auto-map single new unmapped user
  if (unmappedUsers.length === 1) {
    const u = unmappedUsers[0];
    const mapPath = path.join(config.paths.lore, 'speaker-map.json');
    try {
      const map = loadSpeakerMap();
      map.users[u.userId] = { displayName: u.displayName, characterName: u.displayName };
      fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), 'utf-8');
      log.info('Auto-mapped single new speaker', { userId: u.userId, displayName: u.displayName });
    } catch (err) {
      log.warn('Failed to auto-map new speaker', { error: err.message });
    }
  }

  // If there are character switches, we do line-by-line replacement with timestamp awareness
  if (hasCharSwitches) {
    const sessionStart = sessionData?.sessionStart || 0;
    const lines = transcript.split('\n');
    const resultLines = [];

    for (const line of lines) {
      let processedLine = line;

      // Parse timestamp from the line
      const timeMatch = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
      const lineTimeMs = timeMatch
        ? (parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3])) * 1000
        : null;
      const lineAbsoluteTime = lineTimeMs !== null ? sessionStart + lineTimeMs : null;

      for (const [label, userId] of Object.entries(speakerToUser)) {
        const speakerRegex = new RegExp(`Speaker ${label}:`, 'g');
        if (!speakerRegex.test(processedLine)) continue;

        // Determine the correct character name at this timestamp
        const userSwitches = switchesByUser[userId];
        if (userSwitches && userSwitches.length > 0 && lineAbsoluteTime !== null) {
          const mapping = speakerMap.users[userId];
          const playerName = mapping?.displayName || sessionData?.users?.[userId] || `User_${userId.slice(-4)}`;

          // Find the most recent switch before this line's timestamp
          let activeCharacter = mapping?.characterName || playerName;

          // Walk through switches to find the character active at this timestamp
          // Start with the character BEFORE the first switch (the original mapping)
          // For switches: if the line is AFTER a switch timestamp, use the new character
          // We need to figure out the original character (before any switches)
          // The speaker-map now has the LATEST character, so work backwards
          const originalMapping = loadSpeakerMap();
          const origCharName = originalMapping.users[userId]?.characterName || playerName;

          // Build ordered list: first the original character, then each switch
          let currentChar = origCharName;
          // The original char is whatever was in the map BEFORE any switches happened
          // Since switches update the map, we need to infer the original from context
          // We'll use a simpler approach: the first switch implies the char BEFORE it
          // was the original, so we track state linearly
          for (const sw of userSwitches) {
            if (lineAbsoluteTime >= sw.timestamp) {
              currentChar = sw.newCharacter;
            }
          }

          const replacement = playerName !== currentChar
            ? `${playerName} (${currentChar})`
            : currentChar;

          processedLine = processedLine.replace(new RegExp(`Speaker ${label}:`, 'g'), `${replacement}:`);
        } else {
          // No switches for this user, use default label replacement
          processedLine = processedLine.replace(
            new RegExp(`Speaker ${label}:`, 'g'),
            `${labelReplacements[label]}:`
          );
        }
      }

      resultLines.push(processedLine);
    }

    return { transcript: resultLines.join('\n'), unmappedUsers };
  }

  // No character switches — simple global replacement
  let result = transcript;
  for (const [label, replacement] of Object.entries(labelReplacements)) {
    const regex = new RegExp(`Speaker ${label}:`, 'g');
    result = result.replace(regex, `${replacement}:`);
  }

  return { transcript: result, unmappedUsers };
}

// ─── Utilities ──────────────────────────────────────────────────────

function dateString() {
  return new Date().toISOString().slice(0, 10);
}

function outputPath() {
  return path.join(config.paths.transcripts, `session-${dateString()}.txt`);
}

function findLatestRecording() {
  const dir = config.paths.recordings;
  const files = fs.readdirSync(dir)
    .filter(f => /^session-.*\.(ogg|pcm|wav|mp3|webm)$/.test(f))
    .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) throw new Error('No recording files found in ' + dir);
  return path.join(dir, files[0].name);
}

/**
 * Format milliseconds to HH:MM:SS
 */
function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ═══════════════════════════════════════════════════════════════════
//  BACKEND 1 — Local Whisper (Python openai-whisper or whisper.cpp)
// ═══════════════════════════════════════════════════════════════════

async function transcribeWhisperLocal(audioPath) {
  log.info('Transcribing with local Whisper', { audioPath });

  const { binaryPath, model, language, cppModelPath } = config.transcription.whisper;

  // Determine if we're using whisper.cpp or Python whisper
  const isCpp = cppModelPath && fs.existsSync(cppModelPath);

  let rawOutput;

  if (isCpp) {
    // whisper.cpp: output as JSON for easier parsing
    const args = [
      '-m', cppModelPath,
      '-f', audioPath,
      '-l', language,
      '--output-json',
      '--print-progress',
    ];
    rawOutput = execSync(`"${binaryPath}" ${args.join(' ')}`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30 * 60 * 1000, // 30 min timeout
    });
  } else {
    // Python openai-whisper: use --output_format json
    const tmpDir = path.join(config.paths.transcripts, '_whisper_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    execSync(
      `"${binaryPath}" "${audioPath}" --model ${model} --language ${language} ` +
      `--output_format json --output_dir "${tmpDir}" --verbose False`,
      {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60 * 60 * 1000, // 60 min timeout for large models
      }
    );

    // Whisper writes <basename>.json
    const baseName = path.basename(audioPath, path.extname(audioPath));
    const jsonPath = path.join(tmpDir, `${baseName}.json`);
    rawOutput = fs.readFileSync(jsonPath, 'utf-8');

    // Clean up temp
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }

  // Parse Whisper JSON output → transcript lines
  const data = JSON.parse(rawOutput);
  const segments = data.segments || [];

  const lines = segments.map(seg => {
    const time = formatTime(seg.start * 1000);
    // Local Whisper doesn't do diarization — label as "Speaker"
    return `[${time}] Speaker: ${seg.text.trim()}`;
  });

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
//  BACKEND 2 — AssemblyAI (cloud, speaker diarization)
// ═══════════════════════════════════════════════════════════════════

async function transcribeAssemblyAI(audioPath) {
  log.info('Transcribing with AssemblyAI', { audioPath });

  const apiKey = config.transcription.assemblyai.apiKey;
  if (!apiKey || apiKey.includes('YOUR_')) {
    throw new Error('AssemblyAI API key not configured. Set ASSEMBLYAI_API_KEY in .env');
  }

  const baseUrl = 'https://api.assemblyai.com/v2';

  // Step 1: Upload the audio file as raw binary
  log.info('Uploading audio to AssemblyAI...');
  const audioBuffer = fs.readFileSync(audioPath);
  log.info('Audio file size', { bytes: audioBuffer.length, path: audioPath });

  const uploadRes = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/octet-stream',
    },
    body: audioBuffer,
  });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text().catch(() => '(no body)');
    throw new Error(`AssemblyAI upload failed (${uploadRes.status}): ${errBody}`);
  }

  const uploadData = await uploadRes.json();
  const uploadUrl = uploadData.upload_url;
  log.info('Audio uploaded successfully', { upload_url: uploadUrl });

  // Step 2: Start transcription with speaker labels
  log.info('Starting transcription job...');
  const transcriptRes = await fetch(`${baseUrl}/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speaker_labels: true,
      language_code: 'en',
      speakers_expected: 5,
      speech_models: ['universal-3-pro'],
    }),
  });

  if (!transcriptRes.ok) {
    const errBody = await transcriptRes.text().catch(() => '(no body)');
    throw new Error(`AssemblyAI transcript request failed (${transcriptRes.status}): ${errBody}`);
  }

  const { id: transcriptId } = await transcriptRes.json();
  log.info('Transcription job created', { transcriptId });

  // Step 3: Poll until complete
  log.info('Waiting for transcription to complete...', { transcriptId });
  let result;
  while (true) {
    await new Promise(r => setTimeout(r, 5000));

    const pollRes = await fetch(`${baseUrl}/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });

    if (!pollRes.ok) {
      const errBody = await pollRes.text().catch(() => '(no body)');
      throw new Error(`AssemblyAI poll failed (${pollRes.status}): ${errBody}`);
    }

    result = await pollRes.json();

    if (result.status === 'completed') break;
    if (result.status === 'error') {
      throw new Error(`AssemblyAI transcription error: ${result.error}`);
    }
    log.debug('Still transcribing...', { status: result.status });
  }

  log.info('Transcription completed', { transcriptId });

  // Step 4: Format with speaker labels
  const utterances = result.utterances || [];
  if (utterances.length > 0) {
    return utterances.map(u => {
      const time = formatTime(u.start);
      return `[${time}] Speaker ${u.speaker}: ${u.text}`;
    }).join('\n');
  }

  // Fallback to words if no utterances
  return result.text || '(empty transcript)';
}

// ═══════════════════════════════════════════════════════════════════
//  BACKEND 3 — Deepgram (cloud, fast, good diarization)
// ═══════════════════════════════════════════════════════════════════

async function transcribeDeepgram(audioPath) {
  log.info('Transcribing with Deepgram', { audioPath });

  const apiKey = config.transcription.deepgram.apiKey;
  if (!apiKey || apiKey.includes('YOUR_')) {
    throw new Error('Deepgram API key not configured. Set DEEPGRAM_API_KEY in .env');
  }

  const { model, diarize, punctuate, language } = config.transcription.deepgram;

  const params = new URLSearchParams({
    model,
    diarize: String(diarize),
    punctuate: String(punctuate),
    language,
    utterances: 'true',
  });

  const audioData = fs.readFileSync(audioPath);

  // Detect content type from extension
  const ext = path.extname(audioPath).toLowerCase();
  const mimeTypes = {
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.webm': 'audio/webm',
    '.pcm': 'audio/l16;rate=48000;channels=2',
  };
  const contentType = mimeTypes[ext] || 'audio/ogg';

  log.info('Sending audio to Deepgram...');
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': contentType,
    },
    body: audioData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Deepgram API error ${res.status}: ${errText}`);
  }

  const data = await res.json();

  // Use utterances for speaker-labelled output
  const utterances = data.results?.utterances || [];
  if (utterances.length > 0) {
    return utterances.map(u => {
      const time = formatTime(u.start * 1000);
      return `[${time}] Speaker ${u.speaker}: ${u.transcript}`;
    }).join('\n');
  }

  // Fallback: paragraphs from the first channel/alternative
  const paragraphs = data.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || [];
  if (paragraphs.length > 0) {
    const lines = [];
    for (const para of paragraphs) {
      for (const sentence of para.sentences) {
        const time = formatTime(sentence.start * 1000);
        lines.push(`[${time}] Speaker ${para.speaker}: ${sentence.text}`);
      }
    }
    return lines.join('\n');
  }

  // Last resort: plain transcript
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '(empty transcript)';
}

// ═══════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Transcribe an audio file using the configured backend.
 *
 * @param {string} audioPath  Path to the audio file
 * @param {object} [opts]     Override options
 * @param {string} [opts.service]  Force a specific backend
 * @returns {Promise<string>} Path to the saved transcript file
 */
async function transcribe(audioPath, opts = {}) {
  const service = opts.service || config.transcription.service;
  const resolvedPath = path.resolve(audioPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Audio file not found: ${resolvedPath}`);
  }

  log.info(`Starting transcription`, { service, file: resolvedPath });

  let transcript;
  switch (service) {
    case 'whisper-local':
      transcript = await transcribeWhisperLocal(resolvedPath);
      break;
    case 'assemblyai':
      transcript = await transcribeAssemblyAI(resolvedPath);
      break;
    case 'deepgram':
      transcript = await transcribeDeepgram(resolvedPath);
      break;
    default:
      throw new Error(`Unknown transcription service: ${service}`);
  }

  // ── Speaker mapping: replace generic labels with character names ──
  const speakerMap = loadSpeakerMap();
  const sessionData = loadSessionSpeakers();

  if (sessionData && transcript.includes('Speaker ')) {
    // Parse utterances from transcript for timestamp matching
    const utteranceLines = transcript.split('\n').filter(l => l.trim());
    const parsedUtterances = [];
    for (const line of utteranceLines) {
      const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+Speaker\s+(\w+):\s*/);
      if (match) {
        const ms = (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000;
        // Estimate end as start + 10s or next utterance start (rough)
        parsedUtterances.push({ speaker: match[4], start: ms, end: ms + 10000 });
      }
    }

    // Refine end times: each utterance ends when the next starts
    for (let i = 0; i < parsedUtterances.length - 1; i++) {
      parsedUtterances[i].end = parsedUtterances[i + 1].start;
    }

    if (parsedUtterances.length > 0) {
      const speakerToUser = matchSpeakersToUsers(parsedUtterances, sessionData);
      log.info('Speaker-to-user mapping result', { mappings: speakerToUser });

      const { transcript: mappedTranscript, unmappedUsers } = applySpeakerLabels(
        transcript, speakerToUser, speakerMap, sessionData
      );
      transcript = mappedTranscript;

      if (unmappedUsers.length > 1) {
        log.warn('Multiple unmapped speakers detected — use !speakers to map them', {
          unmapped: unmappedUsers.map(u => `${u.displayName} (${u.userId})`),
        });
      }
    }
  }

  // Save transcript
  const outFile = outputPath();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, transcript, 'utf-8');
  log.info(`Transcript saved`, { path: outFile, lines: transcript.split('\n').length });

  return outFile;
}

// ═══════════════════════════════════════════════════════════════════
//  Scene Break Detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Pre-process a transcript to insert scene break markers where there are
 * significant gaps (>30 seconds) between consecutive lines.
 * This gives the story generator structural guidance for scene transitions.
 *
 * @param {string} transcriptText  The transcript text with [HH:MM:SS] timestamps
 * @param {number} [gapThresholdSec=30]  Gap in seconds to trigger a scene break
 * @returns {string}  Transcript with `\n--- SCENE BREAK ---\n` inserted at gaps
 */
function insertSceneBreaks(transcriptText, gapThresholdSec = 30) {
  const lines = transcriptText.split('\n');
  const result = [];
  let prevTimeSec = null;

  for (const line of lines) {
    const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (match) {
      const currentSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);

      if (prevTimeSec !== null && (currentSec - prevTimeSec) > gapThresholdSec) {
        result.push('');
        result.push('--- SCENE BREAK ---');
        result.push('');
      }

      prevTimeSec = currentSec;
    }

    result.push(line);
  }

  return result.join('\n');
}

// ─── CLI entry point ────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let audioPath;
  if (args.includes('--latest')) {
    audioPath = findLatestRecording();
    log.info('Using latest recording', { path: audioPath });
  } else if (args[0] && !args[0].startsWith('--')) {
    audioPath = args[0];
  } else {
    console.error('Usage: node transcribe.js <audio-file>');
    console.error('       node transcribe.js --latest');
    process.exit(1);
  }

  // Allow overriding service via CLI
  const serviceIdx = args.indexOf('--service');
  const service = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

  try {
    const outFile = await transcribe(audioPath, { service });
    console.log(`\nTranscript saved to: ${outFile}`);
  } catch (err) {
    log.error('Transcription failed', { error: err.message });
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { transcribe, findLatestRecording, insertSceneBreaks };
