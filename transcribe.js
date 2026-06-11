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
const { resolveWorkspace } = require('./modules/workspace');

// ─── Custom Vocabulary for AssemblyAI ─────────────────────────────

/**
 * Common D&D terms that AssemblyAI tends to misrecognize. Boosting these
 * improves accuracy of game-mechanic vocabulary that appears in nearly
 * every session, regardless of the campaign.
 */
const DND_COMMON_TERMS = [
  'initiative', 'Eldritch Blast', 'Fireball', 'cantrip', 'melee', 'ranged',
  'hit points', 'armor class', 'saving throw',
  'perception', 'stealth', 'persuasion', 'intimidation', 'athletics',
  'arcana', 'religion', 'nature', 'insight', 'investigation', 'medicine',
  'survival', 'deception', 'performance', 'sleight of hand',
  'animal handling', 'acrobatics', 'history',
];

/**
 * Read and parse a context JSON file from disk. Returns null on missing
 * file or parse failure (logged at warn level).
 */
function readContextFile(ctxPath) {
  if (!ctxPath || !fs.existsSync(ctxPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
  } catch (err) {
    log.warn('Failed to parse context file for vocabulary', {
      path: ctxPath,
      error: err.message,
    });
    return null;
  }
}

/**
 * Pull boostable terms (character names, NPCs, locations, items, etc.)
 * from a single parsed context object into the supplied Set.
 */
function addContextTerms(ctx, terms) {
  if (!ctx) return;

  if (ctx.campaignName) terms.add(ctx.campaignName);

  if (Array.isArray(ctx.playerCharacters)) {
    for (const pc of ctx.playerCharacters) {
      if (pc && pc.name) terms.add(pc.name);
    }
  }
  if (Array.isArray(ctx.inactiveCharacters)) {
    for (const ic of ctx.inactiveCharacters) {
      if (ic && ic.name) terms.add(ic.name);
    }
  }
  if (Array.isArray(ctx.recurringNPCs)) {
    for (const npc of ctx.recurringNPCs) {
      if (npc && npc.name) terms.add(npc.name);
    }
  }
  if (Array.isArray(ctx.locationsVisited)) {
    for (const loc of ctx.locationsVisited) {
      if (loc) terms.add(loc);
    }
  }
  if (Array.isArray(ctx.itemsOfSignificance)) {
    for (const item of ctx.itemsOfSignificance) {
      if (item) terms.add(item);
    }
  }
  if (ctx.flavorBank) {
    if (ctx.flavorBank.locations) {
      for (const locName of Object.keys(ctx.flavorBank.locations)) {
        terms.add(locName);
      }
    }
    if (ctx.flavorBank.characters) {
      for (const charName of Object.keys(ctx.flavorBank.characters)) {
        terms.add(charName);
      }
    }
  }
}

/**
 * Build a flat array of custom vocabulary terms for AssemblyAI's
 * `word_boost` parameter.
 *
 * Pulls character names, NPCs, locations, items, and flavor-bank names
 * from BOTH campaign-context.json and oneshot-context.json (whichever
 * exists), then appends the standard D&D mechanical-term list.
 *
 * Loaded fresh on every transcription so newly-detected characters
 * are picked up automatically.
 *
 * @returns {string[]} Array of unique vocabulary terms to boost.
 */
function buildCustomVocabulary() {
  const terms = new Set();

  const campaignCtx = readContextFile(config.paths.campaignContext);
  const oneshotCtx = readContextFile(config.paths.oneshotContext);
  addContextTerms(campaignCtx, terms);
  addContextTerms(oneshotCtx, terms);

  for (const t of DND_COMMON_TERMS) terms.add(t);

  const vocabulary = Array.from(terms).filter(t => t && t.trim().length > 0);
  log.info('Built custom vocabulary for transcription', {
    termCount: vocabulary.length,
    fromCampaign: !!campaignCtx,
    fromOneshot: !!oneshotCtx,
  });
  return vocabulary;
}

// ─── Audio Preprocessing with ffmpeg ──────────────────────────────

/**
 * Pre-process an audio file through ffmpeg to clean it up before
 * sending to a transcription service. Applies:
 *   - highpass at 100Hz (remove low-frequency rumble/hum)
 *   - lowpass at 8000Hz (remove high-frequency noise above voice range)
 *   - afftdn with noise floor -25dB (adaptive noise reduction)
 *   - loudnorm (normalize volume levels across speakers)
 *   - resample to 16kHz mono (optimal for speech recognition)
 *
 * If ffmpeg fails for any reason, falls back to the original file.
 *
 * @param {string} inputPath  Path to the raw audio file
 * @returns {string} Path to the cleaned audio file, or the original if preprocessing fails
 */
function preprocessAudio(inputPath) {
  const ext = path.extname(inputPath);
  const baseName = path.basename(inputPath, ext);
  const cleanPath = path.join(config.paths.recordings, `${baseName}-clean.ogg`);

  const ffmpegBin = config.audio.ffmpegPath || 'ffmpeg';

  const filterChain = [
    'highpass=f=100',
    'lowpass=f=8000',
    'afftdn=nf=-25',
    'loudnorm',
    'aresample=16000',
  ].join(',');

  const cmd = `"${ffmpegBin}" -y -i "${inputPath}" -af "${filterChain}" -ac 1 "${cleanPath}"`;

  try {
    log.info('Preprocessing audio with ffmpeg', { input: inputPath, output: cleanPath });
    execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10 * 60 * 1000, // 10 min timeout
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log.info('Audio preprocessing complete', { cleanPath });
    return cleanPath;
  } catch (err) {
    log.warn('ffmpeg preprocessing failed, falling back to original audio', {
      error: err.message,
    });
    return inputPath;
  }
}

// ─── Speaker Map Utilities ─────────────────────────────────────────

/**
 * Load the speaker-map.json file that maps Discord user IDs to character names.
 * @returns {{ users: Object<string, { displayName: string, characterName: string }> }}
 */
function loadSpeakerMap(mapPath = path.join(config.paths.lore, 'speaker-map.json')) {
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

  // ── Timeline warp ────────────────────────────────────────────────
  // The transcript's millisecond timestamps are positions in the *mixed
  // audio file*, while the speaker segments are absolute wall-clock times.
  // Those two clocks should be identical, but the recorder caps each
  // inserted silence gap (see SilencePadTransform.MAX_SILENCE_MS), so a
  // session with long pauses produces an audio file noticeably SHORTER
  // than the real elapsed time. A naive `sessionStart + utt.start` then
  // places every late-session utterance too early; they pile onto whoever
  // talks most overall (the DM) and the whole diarization collapses onto
  // one user.
  //
  // We can't recover where each cap happened from the finished file, but
  // we DO know both endpoints: the audio runs 0 → maxUttEnd, and the real
  // speech runs 0 → (lastSegmentEnd - sessionStart). Stretching audio
  // positions across the full wall-clock span removes the systematic
  // end-of-session compression (anchored at 0, so the well-aligned start
  // is untouched). It's a best-effort linear correction, not exact, but it
  // restores enough alignment for the per-label vote below to separate
  // speakers.
  let maxUttEnd = 0;
  for (const u of utterances) if (u.end > maxUttEnd) maxUttEnd = u.end;
  let maxSegEnd = 0;
  for (const seg of sessionData.segments) if (seg.endTime > maxSegEnd) maxSegEnd = seg.endTime;
  const wallSpan = maxSegEnd - sessionStart;

  let warp = 1;
  if (maxUttEnd > 0 && wallSpan > 0) {
    warp = wallSpan / maxUttEnd;
    // Clamp to a sane range so corrupt data can't produce garbage offsets.
    warp = Math.max(0.5, Math.min(2.0, warp));
  }
  log.info('Speaker-match timeline warp', {
    audioSpanSec: Math.round(maxUttEnd / 1000),
    wallSpanSec: Math.round(wallSpan / 1000),
    warpRatio: Number(warp.toFixed(4)),
  });

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
      // Convert transcript timestamps (ms from start of audio) to absolute
      // wall-clock ms, applying the timeline warp described above.
      const uttStart = sessionStart + utt.start * warp;
      const uttEnd = sessionStart + utt.end * warp;

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

    // Diagnostic: show the top candidates so a collapse is visible in logs.
    const ranked = Object.entries(userOverlap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([uid, ms]) => `${(sessionData.users && sessionData.users[uid]) || uid}=${Math.round(ms / 1000)}s`);
    log.info('Speaker label candidates', {
      label: speakerLabel,
      utterances: utts.length,
      top: ranked,
    });

    if (bestUser) {
      speakerToUser[speakerLabel] = bestUser;
    }
  }

  return speakerToUser;
}

/**
 * Ground-truth diarization from the per-user audio streams.
 *
 * The recorder captures each user on their own silence-padded PCM stream and
 * logs exactly when each user's stream had audio (Discord `speaking` start/end
 * events → sessionData.segments, absolute wall-clock ms). That speaking
 * timeline IS who-spoke-when — it doesn't need to be re-derived from the mixed
 * file by the cloud diarizer.
 *
 * The old path mapped each cloud "Speaker X" label to a single user by voting
 * (matchSpeakersToUsers). One mislabeled cloud speaker then dragged all of its
 * utterances onto whoever talked most overall — the DM — collapsing the whole
 * session onto one name. Here we instead assign EACH utterance independently to
 * the user whose speaking segment best overlaps it, so a single bad attribution
 * can never cascade. The cloud speaker labels are discarded entirely.
 *
 * Returns relabeled utterances (each `.speaker` set to its owning userId) plus a
 * 1:1 speakerToUser map, so the existing applySpeakerLabels rendering (character
 * names, mid-session character switches, unmapped-user detection) is reused as-is.
 *
 * @param {Array<{ speaker: string, start: number, end: number, text?: string }>} utterances
 * @param {{ sessionStart: number, segments: Array<{ userId: string, startTime: number, endTime: number }>, users: Object }} sessionData
 * @returns {{ utterances: Array, speakerToUser: Object<string,string>, assigned: number, total: number }}
 */
function assignUtterancesToUsers(utterances, sessionData) {
  if (!sessionData || !Array.isArray(sessionData.segments) || sessionData.segments.length === 0) {
    return { utterances, speakerToUser: {}, assigned: 0, total: utterances.length };
  }

  const sessionStart = sessionData.sessionStart;
  const segments = sessionData.segments;

  // No timeline warp: the per-user PCM streams are silence-padded from the same
  // sessionStart, so an utterance at audio-time T sits at wall-clock
  // sessionStart + T. We assign each utterance independently to the user whose
  // recorded speaking segment overlaps it, which is local and robust to the
  // small drift a (rare) capped silence gap could introduce — exactly the point
  // of using ground truth instead of the global linear-warp heuristic.

  const relabeled = [];
  let assigned = 0;
  const usersSeen = new Set();

  for (const utt of utterances) {
    const uttStart = sessionStart + utt.start;
    const uttEnd = sessionStart + utt.end;
    const uttMid = (uttStart + uttEnd) / 2;

    // 1) Prefer the user with the most overlap with this utterance's window.
    let bestUser = null;
    let bestOverlap = 0;
    // 2) Tie-break / fallback: the user whose segment midpoint is nearest.
    let nearestUser = null;
    let nearestDist = Infinity;

    for (const seg of segments) {
      const overlapStart = Math.max(uttStart, seg.startTime);
      const overlapEnd = Math.min(uttEnd, seg.endTime);
      const overlap = overlapEnd - overlapStart;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestUser = seg.userId;
      }
      const dist = Math.abs(((seg.startTime + seg.endTime) / 2) - uttMid);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestUser = seg.userId;
      }
    }

    const chosen = bestUser || nearestUser;
    if (bestUser) assigned++;
    if (chosen) usersSeen.add(chosen);

    // Relabel the utterance with its owning user so downstream rendering keys
    // off ground truth, not the cloud label. Keep the original if unresolved.
    relabeled.push(chosen ? { ...utt, speaker: chosen } : { ...utt });
  }

  // 1:1 map: each surfaced label IS a userId.
  const speakerToUser = {};
  for (const uid of usersSeen) speakerToUser[uid] = uid;

  log.info('Ground-truth diarization', {
    utterances: utterances.length,
    assignedByOverlap: assigned,
    distinctUsers: usersSeen.size,
  });

  return { utterances: relabeled, speakerToUser, assigned, total: utterances.length };
}

/**
 * Render utterances (already relabeled so `.speaker` is a userId) back into the
 * `[HH:MM:SS] Speaker <userId>: text` line format that applySpeakerLabels
 * consumes. Used after assignUtterancesToUsers so the rest of the speaker→name
 * pipeline is unchanged.
 */
function renderUtterancesWithLabels(utterances) {
  return utterances
    .map(u => `[${formatTime(u.start)}] Speaker ${u.speaker}: ${u.text || ''}`)
    .join('\n');
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
function applySpeakerLabels(transcript, speakerToUser, speakerMap, sessionData, speakerMapPath = path.join(config.paths.lore, 'speaker-map.json')) {
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
    const mapPath = speakerMapPath;
    try {
      const map = loadSpeakerMap(speakerMapPath);
      map.users[u.userId] = { displayName: u.displayName, characterName: u.displayName };
      fs.mkdirSync(path.dirname(mapPath), { recursive: true });
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
          const originalMapping = loadSpeakerMap(speakerMapPath);
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

  // No diarization → no per-speaker labels to match against.
  return { text: lines.join('\n'), utterances: [] };
}

// ═══════════════════════════════════════════════════════════════════
//  BACKEND 2 — AssemblyAI (cloud, speaker diarization)
// ═══════════════════════════════════════════════════════════════════

/**
 * Inner AssemblyAI call.  Caller controls knobs that we may flip on
 * retry — currently `useKeyterms` and `speechModel`.
 *
 * @param {string} audioPath
 * @param {object} [opts]
 * @param {boolean} [opts.useKeyterms=true]  Send custom vocabulary
 * @param {string}  [opts.speechModel='universal-3-pro']  AssemblyAI speech_models entry
 */
async function transcribeAssemblyAIOnce(audioPath, opts = {}) {
  const useKeyterms = opts.useKeyterms !== false;
  const speechModel = opts.speechModel || 'universal-3-pro';

  log.info('Transcribing with AssemblyAI', { audioPath, useKeyterms, speechModel });

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
  const requestBody = {
    audio_url: uploadUrl,
    speaker_labels: true,
    language_code: 'en',
    speakers_expected: 5,
    speech_models: [speechModel],
  };
  if (useKeyterms) {
    requestBody.keyterms_prompt = buildCustomVocabulary();
  }

  const transcriptRes = await fetch(`${baseUrl}/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!transcriptRes.ok) {
    const errBody = await transcriptRes.text().catch(() => '(no body)');
    throw new Error(`AssemblyAI transcript request failed (${transcriptRes.status}): ${errBody}`);
  }

  const { id: transcriptId } = await transcriptRes.json();
  log.info('Transcription job created', { transcriptId });

  // Step 3: Poll until complete — bounded by a wall-clock budget so a job
  // stuck in a non-terminal state (queued/processing forever) can't hang the
  // pipeline indefinitely. An unbounded loop here would hold the per-guild
  // processing lock until the process is restarted, blocking all recordings.
  const POLL_INTERVAL_MS = 5000;
  const POLL_TIMEOUT_MS = parseInt(process.env.ASSEMBLYAI_POLL_TIMEOUT_MS, 10) || 45 * 60 * 1000;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  log.info('Waiting for transcription to complete...', {
    transcriptId,
    timeoutMinutes: Math.round(POLL_TIMEOUT_MS / 60000),
  });
  let result;
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        `AssemblyAI transcription timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} min ` +
        `(transcriptId ${transcriptId}, last status: ${result?.status || 'unknown'})`
      );
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

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
    const text = utterances.map(u => {
      const time = formatTime(u.start);
      return `[${time}] Speaker ${u.speaker}: ${u.text}`;
    }).join('\n');
    // Preserve real millisecond start/end timings for speaker→user matching.
    const timed = utterances.map(u => ({
      speaker: u.speaker, start: u.start, end: u.end, text: u.text,
    }));
    // Cache the raw diarized utterances next to the audio. Re-running the
    // (free, local) speaker→user mapping then never requires paying for a
    // second transcription — see remapFromCache().
    saveRawUtteranceCache(audioPath, timed, result.audio_duration);
    return { text, utterances: timed };
  }

  // Fallback to words if no utterances
  return { text: result.text || '(empty transcript)', utterances: [] };
}

/**
 * Build the sidecar path for a recording's cached raw diarized utterances.
 * Strips a trailing "-clean" (the ffmpeg-preprocessed copy) so the cache is
 * keyed to the original session, not the temporary cleaned file.
 */
function rawCachePath(audioPath) {
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath).replace(/\.[^.]+$/, '').replace(/-clean$/, '');
  return path.join(dir, `${base}-assemblyai-raw.json`);
}

function saveRawUtteranceCache(audioPath, utterances, audioDuration) {
  try {
    const out = rawCachePath(audioPath);
    fs.writeFileSync(out, JSON.stringify({ audioDuration, utterances }, null, 2), 'utf-8');
    log.info('Cached raw diarized utterances', { path: out, count: utterances.length });
  } catch (err) {
    log.warn('Could not cache raw utterances', { error: err.message });
  }
}

/**
 * AssemblyAI with up to three attempts — each with different
 * fallback knobs.  We never give up before exhausting them; the
 * recording stays on disk regardless.
 *
 *   Attempt 1: full quality (universal-3-pro + keyterms_prompt)
 *   Attempt 2: drop keyterms_prompt (some accounts/regions reject it)
 *   Attempt 3: switch to a different speech model (universal)
 */
async function transcribeAssemblyAI(audioPath) {
  const attempts = [
    { useKeyterms: true,  speechModel: 'universal-3-pro', label: 'full' },
    { useKeyterms: false, speechModel: 'universal-3-pro', label: 'no-keyterms' },
    { useKeyterms: false, speechModel: 'universal',       label: 'fallback-model' },
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      log.info('AssemblyAI attempt', { attempt: i + 1, of: attempts.length, ...attempt });
      return await transcribeAssemblyAIOnce(audioPath, attempt);
    } catch (err) {
      lastErr = err;
      log.warn(`AssemblyAI attempt ${i + 1}/${attempts.length} failed`, {
        attempt: attempt.label,
        error: err.message,
      });
    }
  }

  throw new Error(`AssemblyAI failed after ${attempts.length} attempts: ${lastErr?.message || 'unknown error'}`);
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
    const text = utterances.map(u => {
      const time = formatTime(u.start * 1000);
      return `[${time}] Speaker ${u.speaker}: ${u.transcript}`;
    }).join('\n');
    // Deepgram reports timings in seconds — normalise to ms for matching.
    const timed = utterances.map(u => ({
      speaker: String(u.speaker), start: u.start * 1000, end: u.end * 1000, text: u.transcript,
    }));
    return { text, utterances: timed };
  }

  // Fallback: paragraphs from the first channel/alternative
  const paragraphs = data.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || [];
  if (paragraphs.length > 0) {
    const lines = [];
    const timed = [];
    for (const para of paragraphs) {
      for (const sentence of para.sentences) {
        const time = formatTime(sentence.start * 1000);
        lines.push(`[${time}] Speaker ${para.speaker}: ${sentence.text}`);
        timed.push({
          speaker: String(para.speaker),
          start: sentence.start * 1000,
          end: sentence.end * 1000,
          text: sentence.text,
        });
      }
    }
    return { text: lines.join('\n'), utterances: timed };
  }

  // Last resort: plain transcript
  return {
    text: data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '(empty transcript)',
    utterances: [],
  };
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
 * @param {string} [opts.guildId]  Guild id for per-guild speaker-map isolation
 * @returns {Promise<string>} Path to the saved transcript file
 */
async function transcribe(audioPath, opts = {}) {
  const service = opts.service || config.transcription.service;
  const speakerMapPath = resolveWorkspace(opts.guildId).speakerMap;
  const resolvedPath = path.resolve(audioPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Audio file not found: ${resolvedPath}`);
  }

  log.info(`Starting transcription`, { service, file: resolvedPath });

  // Pre-process audio through ffmpeg for cleaner transcription
  const processedPath = preprocessAudio(resolvedPath);
  if (processedPath !== resolvedPath) {
    log.info('Using preprocessed audio', { original: resolvedPath, processed: processedPath });
  }

  let result;
  switch (service) {
    case 'whisper-local':
      result = await transcribeWhisperLocal(processedPath);
      break;
    case 'assemblyai':
      result = await transcribeAssemblyAI(processedPath);
      break;
    case 'deepgram':
      result = await transcribeDeepgram(processedPath);
      break;
    default:
      throw new Error(`Unknown transcription service: ${service}`);
  }

  let transcript = result.text;
  const timedUtterances = result.utterances || [];

  // ── Speaker mapping: replace generic labels with character names ──
  const speakerMap = loadSpeakerMap(speakerMapPath);
  const sessionData = loadSessionSpeakers();

  if (sessionData && transcript.includes('Speaker ')) {
    // Prefer the backend's real millisecond utterance timings. The older
    // path re-parsed the [HH:MM:SS] text (second resolution) and set each
    // utterance's end to the *next* utterance's start — which stretched
    // every utterance across the following silence/gap. Those bloated
    // windows overlapped whoever spoke most overall (the DM), collapsing
    // every diarized label onto a single user. Using the true per-utterance
    // start/end keeps each window tight to what was actually said.
    let parsedUtterances = timedUtterances;

    if (parsedUtterances.length === 0) {
      // Fallback (e.g. a transcript loaded from disk with no timing data):
      // re-parse the text, but bound each utterance to its spoken length
      // (~2.5 words/sec) instead of letting it run to the next utterance.
      const utteranceLines = transcript.split('\n').filter(l => l.trim());
      parsedUtterances = [];
      for (const line of utteranceLines) {
        const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+Speaker\s+(\w+):\s*(.*)$/);
        if (match) {
          const ms = (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000;
          const wordCount = (match[5].trim().match(/\S+/g) || []).length;
          const estDuration = Math.max(1000, Math.round((wordCount / 2.5) * 1000));
          parsedUtterances.push({ speaker: match[4], start: ms, end: ms + estDuration });
        }
      }
    }

    if (parsedUtterances.length > 0) {
      // Ground-truth diarization: when we have real per-utterance text AND the
      // recorder's per-user speaking timeline, attribute each utterance directly
      // to its owning user from that timeline (see assignUtterancesToUsers),
      // discarding the cloud "Speaker X" labels. This replaces the fragile
      // per-label vote + timeline-warp that kept collapsing onto the DM.
      const haveText = parsedUtterances.every(u => typeof u.text === 'string');
      const haveSegments = sessionData && Array.isArray(sessionData.segments) && sessionData.segments.length > 0;

      let workingTranscript = transcript;
      let speakerToUser;

      if (haveText && haveSegments) {
        const gt = assignUtterancesToUsers(parsedUtterances, sessionData);
        speakerToUser = gt.speakerToUser;
        // Re-render lines as "Speaker <userId>:" so applySpeakerLabels resolves
        // them to character names via the now-1:1, ground-truth mapping.
        workingTranscript = renderUtterancesWithLabels(gt.utterances);
      } else {
        // Fallback (no timing/text, e.g. a transcript reloaded from disk):
        // the older cloud-label vote against speaking segments.
        speakerToUser = matchSpeakersToUsers(parsedUtterances, sessionData);
      }
      log.info('Speaker-to-user mapping result', { mappings: speakerToUser });

      const { transcript: mappedTranscript, unmappedUsers } = applySpeakerLabels(
        workingTranscript, speakerToUser, speakerMap, sessionData, speakerMapPath
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

/**
 * Re-run the (free, local) speaker→user mapping from a cached raw-utterance
 * file produced by an earlier AssemblyAI run — no re-transcription needed.
 * Used both by the `--remap` CLI subcommand and for offline matcher tuning.
 *
 * @param {string} cachePath  Path to a *-assemblyai-raw.json cache file
 * @returns {{ outFile: string, speakerToUser: Object, unmappedUsers: Array }}
 */
function remapFromCache(cachePath) {
  const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  const utterances = raw.utterances || [];
  if (utterances.length === 0) throw new Error(`No utterances in cache: ${cachePath}`);

  const text = utterances
    .map(u => `[${formatTime(u.start)}] Speaker ${u.speaker}: ${u.text}`)
    .join('\n');

  const speakerMap = loadSpeakerMap();
  const sessionData = loadSessionSpeakers();
  if (!sessionData) throw new Error('No speakers.json found to map against');

  // Ground-truth diarization from the per-user speaking timeline (the cache
  // retains real per-utterance text + timing), falling back to the cloud-label
  // vote only if no speaking segments were recorded.
  const haveSegments = Array.isArray(sessionData.segments) && sessionData.segments.length > 0;
  let renderText = text;
  let speakerToUser;
  if (haveSegments) {
    const gt = assignUtterancesToUsers(utterances, sessionData);
    speakerToUser = gt.speakerToUser;
    renderText = renderUtterancesWithLabels(gt.utterances);
  } else {
    speakerToUser = matchSpeakersToUsers(utterances, sessionData);
  }
  log.info('Speaker-to-user mapping result (remap)', { mappings: speakerToUser });

  const { transcript, unmappedUsers } = applySpeakerLabels(renderText, speakerToUser, speakerMap, sessionData);

  const outFile = outputPath();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, transcript, 'utf-8');
  log.info('Transcript saved (remap)', { path: outFile, lines: transcript.split('\n').length });

  return { outFile, speakerToUser, unmappedUsers };
}

async function main() {
  const args = process.argv.slice(2);

  // ── Offline re-map: rebuild speaker labels from a cached transcription ──
  const remapIdx = args.indexOf('--remap');
  if (remapIdx !== -1) {
    let cachePath = args[remapIdx + 1];
    if (!cachePath || cachePath.startsWith('--')) {
      // Default to the newest cache in the recordings dir.
      const dir = config.paths.recordings;
      const caches = fs.readdirSync(dir)
        .filter(f => f.endsWith('-assemblyai-raw.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (caches.length === 0) { console.error('No *-assemblyai-raw.json cache found'); process.exit(1); }
      cachePath = path.join(dir, caches[0].name);
    }
    try {
      const { outFile, speakerToUser } = remapFromCache(cachePath);
      console.log(`\nRe-mapped from ${cachePath}`);
      console.log('Mapping:', JSON.stringify(speakerToUser, null, 2));
      console.log(`Transcript saved to: ${outFile}`);
    } catch (err) {
      log.error('Remap failed', { error: err.message });
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
    return;
  }

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

module.exports = { transcribe, findLatestRecording, insertSceneBreaks, buildCustomVocabulary, preprocessAudio, matchSpeakersToUsers, assignUtterancesToUsers, renderUtterancesWithLabels, applySpeakerLabels, remapFromCache };
