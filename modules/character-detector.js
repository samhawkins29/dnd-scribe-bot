/**
 * Character Introduction Detector
 *
 * Scans the opening of a session transcript (first 30-60 minutes if
 * timestamps are present, otherwise the first third) for character
 * introductions and extracts {speakerLabel, characterName, race, class}.
 *
 * Uses a direct REST call to the Anthropic API (no SDK) because the
 * Anthropic Python SDK's pydantic DLLs are blocked by Windows
 * Application Control on the host. Calls Sonnet for cost efficiency.
 *
 * Auto-updates the appropriate context file (campaign-context.json or
 * oneshot-context.json) with any newly-detected characters.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');
const { callClaude } = require('./anthropic-client');

// ─── Transcript slicing ───────────────────────────────────────────

/**
 * Return the opening portion of the transcript to scan for introductions.
 * If [HH:MM:SS] timestamps are present and the session is longer than
 * 30 minutes, slice up to the 60-minute mark. If the session is shorter
 * than 30 minutes, return the whole transcript. If no timestamps are
 * found, fall back to the first third of the line count.
 */
function getEarlyTranscriptPortion(transcript) {
  const lines = transcript.split('\n');
  const tsRe = /\[(\d{2}):(\d{2}):(\d{2})\]/;

  // Find the last timestamp in the transcript (session length)
  let lastTimestampSec = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(tsRe);
    if (m) {
      lastTimestampSec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      break;
    }
  }

  // Fallback: no timestamps detected at all → take first third
  if (lastTimestampSec === null) {
    const oneThird = Math.max(1, Math.floor(lines.length / 3));
    return lines.slice(0, oneThird).join('\n');
  }

  // Session shorter than 30 min — scan it all
  if (lastTimestampSec < 1800) {
    return transcript;
  }

  // Otherwise slice up to the 60-minute mark
  const cutoffSec = 3600;
  const earlyLines = [];
  for (const line of lines) {
    const m = line.match(tsRe);
    if (m) {
      const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      if (sec > cutoffSec) break;
    }
    earlyLines.push(line);
  }
  return earlyLines.join('\n');
}

// ─── Context file I/O ─────────────────────────────────────────────

function getContextPath(sessionType, ws) {
  if (ws) {
    return sessionType === 'oneshot' ? ws.oneshotContext : ws.campaignContext;
  }
  return sessionType === 'oneshot'
    ? config.paths.oneshotContext
    : config.paths.campaignContext;
}

function loadContext(sessionType, ws) {
  const ctxPath = getContextPath(sessionType, ws);
  if (!ctxPath || !fs.existsSync(ctxPath)) {
    return { ctx: { playerCharacters: [] }, ctxPath };
  }
  try {
    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    if (!Array.isArray(ctx.playerCharacters)) ctx.playerCharacters = [];
    return { ctx, ctxPath };
  } catch (err) {
    log.warn('Failed to parse context file for character detector', {
      path: ctxPath,
      error: err.message,
    });
    return { ctx: { playerCharacters: [] }, ctxPath };
  }
}

function saveContext(ctxPath, ctx) {
  fs.mkdirSync(path.dirname(ctxPath), { recursive: true });
  fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), 'utf-8');
}

// ─── JSON parsing ─────────────────────────────────────────────────

function parseJsonArray(rawText) {
  if (!rawText) return null;
  // Strip a leading/trailing markdown fence if present
  let stripped = rawText.trim();
  stripped = stripped.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Look for the outermost array bounds
  const first = stripped.indexOf('[');
  const last = stripped.lastIndexOf(']');
  if (first === -1 || last <= first) return null;

  try {
    return JSON.parse(stripped.slice(first, last + 1));
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Scan the opening of a transcript for character introductions and
 * auto-update the appropriate context file with new characters.
 *
 * @param {string} transcript          The full transcript text.
 * @param {'campaign'|'oneshot'} sessionType  Which context file to read/update.
 * @returns {Promise<Array<{speakerLabel: string, characterName: string, race: string, class: string, isNew?: boolean}>>}
 */
async function detectCharacterIntroductions(transcript, sessionType = 'campaign', ws = null) {
  if (!transcript || !transcript.trim()) {
    log.warn('Empty transcript passed to character detector');
    return [];
  }

  const earlyTranscript = getEarlyTranscriptPortion(transcript);
  const { ctx, ctxPath } = loadContext(sessionType, ws);

  const knownCharacters = (ctx.playerCharacters || [])
    .filter(pc => pc && pc.name && pc.race && pc.class)
    .map(pc => `- ${pc.name} (${pc.race} ${pc.class})${pc.player ? ` [player: ${pc.player}]` : ''}`);

  const prompt = `You are analyzing the opening of a D&D session transcript to identify character introductions made by the players.

Look for moments where a player explicitly introduces their character. Examples:
- "I'm playing Thrain, a dwarf paladin"
- "My character is Breme, he's a human rogue"
- "This is Meridio, bronze dragonborn wizard"

The transcript may have speaker labels like "Speaker A:", "Speaker B:" or already-resolved player/character names. Use whatever appears at the start of each line as the speakerLabel.

KNOWN CHARACTERS (do not list as new — but include them with isNew=false to confirm the speaker mapping if they are mentioned):
${knownCharacters.length > 0 ? knownCharacters.join('\n') : '(none)'}

Return ONLY a JSON array (no markdown fences, no commentary). Each entry must have:
{
  "speakerLabel": "exact speaker label as it appears in the transcript",
  "characterName": "string",
  "race": "string",
  "class": "string",
  "isNew": true | false
}

If no character introductions are detected, return an empty array: []

=== TRANSCRIPT (opening portion) ===
${earlyTranscript}`;

  let raw;
  try {
    raw = await callClaude(prompt, 2048);
  } catch (err) {
    log.warn('Character detection Sonnet call failed', { error: err.message });
    return [];
  }

  const detected = parseJsonArray(raw);
  if (!Array.isArray(detected)) {
    log.warn('Character detection did not return a parseable JSON array', {
      rawSnippet: (raw || '').slice(0, 200),
    });
    return [];
  }

  // Normalize: filter out malformed entries
  const cleaned = detected.filter(d =>
    d && typeof d === 'object' && d.characterName && typeof d.characterName === 'string'
  );

  // Add NEW characters to the context file
  const knownNames = new Set(
    (ctx.playerCharacters || [])
      .map(pc => (pc && pc.name ? pc.name.toLowerCase() : ''))
      .filter(Boolean)
  );

  const newChars = cleaned.filter(c =>
    c.isNew === true && !knownNames.has(c.characterName.toLowerCase())
  );

  if (newChars.length > 0) {
    if (!Array.isArray(ctx.playerCharacters)) ctx.playerCharacters = [];
    for (const nc of newChars) {
      ctx.playerCharacters.push({
        name: nc.characterName,
        race: nc.race || '',
        class: nc.class || '',
        player: nc.speakerLabel || '',
      });
      knownNames.add(nc.characterName.toLowerCase());
    }
    try {
      saveContext(ctxPath, ctx);
      log.info('Character context updated with new detections', {
        sessionType,
        contextPath: ctxPath,
        added: newChars.map(c => c.characterName),
      });
    } catch (err) {
      log.warn('Failed to save updated context file', { path: ctxPath, error: err.message });
    }
  }

  log.info('Character detection complete', {
    sessionType,
    detectedCount: cleaned.length,
    newAdded: newChars.length,
  });

  return cleaned;
}

module.exports = {
  detectCharacterIntroductions,
  // exported for tests
  getEarlyTranscriptPortion,
};
