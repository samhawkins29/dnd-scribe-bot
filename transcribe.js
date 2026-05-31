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
    const text = utterances.map(u => {
      const time = formatTime(u.start);
      return `[${time}] Speaker ${u.speaker}: ${u.text}`;
    }).join('\n');
    // Preserve real millisecond start/end timings for speaker→user matching.
    const timed = utterances.map(u => ({
      speaker: u.speaker, start: u.start, end: u.end, text: u.text,
    }));
    return { text, utterances: timed };
  }

  // Fallback to words if no utterances
  return { text: result.text || '(empty transcript)', utterances: [] };
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
 * @returns {Promise<string>} Path to the saved transcript file
 */
async function transcribe(audioPath, opts = {}) {
  const service = opts.service || config.transcription.service;
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
  const speakerMap = loadSpeakerMap();
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

module.exports = { transcribe, findLatestRecording, insertSceneBreaks, buildCustomVocabulary, preprocessAudio };
