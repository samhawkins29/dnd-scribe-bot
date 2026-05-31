/**
 * Post-Transcription Correction Pass
 *
 * Runs after transcription and character detection. Reads known names
 * (player characters, NPCs, locations) from the campaign and one-shot
 * context files, then asks Sonnet to fix likely speech-to-text
 * misrecognitions of those names while leaving the rest of the
 * transcript untouched.
 *
 * Uses the shared Anthropic REST client (no SDK) — see
 * anthropic-client.js for the rationale.
 */

const fs = require('fs');
const config = require('../config');
const log = require('../logger');
const { callClaude } = require('./anthropic-client');

// ─── Known-term collection ────────────────────────────────────────

function collectKnownTerms() {
  const characters = new Set();
  const npcs = new Set();
  const locations = new Set();

  const ctxPaths = [config.paths.campaignContext, config.paths.oneshotContext]
    .filter(Boolean);

  for (const ctxPath of ctxPaths) {
    if (!fs.existsSync(ctxPath)) continue;
    let ctx;
    try {
      ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    } catch (err) {
      log.warn('Corrector failed to parse context file', { path: ctxPath, error: err.message });
      continue;
    }

    if (Array.isArray(ctx.playerCharacters)) {
      for (const pc of ctx.playerCharacters) {
        if (pc && pc.name) characters.add(pc.name);
      }
    }
    if (Array.isArray(ctx.inactiveCharacters)) {
      for (const ic of ctx.inactiveCharacters) {
        if (ic && ic.name) characters.add(ic.name);
      }
    }
    if (Array.isArray(ctx.recurringNPCs)) {
      for (const npc of ctx.recurringNPCs) {
        if (npc && npc.name) npcs.add(npc.name);
      }
    }
    if (Array.isArray(ctx.locationsVisited)) {
      for (const loc of ctx.locationsVisited) {
        if (loc) locations.add(loc);
      }
    }
  }

  return {
    characters: Array.from(characters),
    npcs: Array.from(npcs),
    locations: Array.from(locations),
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Correct phonetic misrecognitions of known names in a transcript.
 *
 * @param {string} transcript  The full transcript text.
 * @returns {Promise<string>}  Corrected transcript (or original on failure).
 */
async function correctTranscript(transcript) {
  if (!transcript || !transcript.trim()) return transcript;

  const known = collectKnownTerms();
  const totalKnown = known.characters.length + known.npcs.length + known.locations.length;
  if (totalKnown === 0) {
    log.info('Corrector: no known names available — skipping correction pass');
    return transcript;
  }

  const prompt = `You are a transcript corrector for a D&D (Dungeons & Dragons) session. The transcript was produced by speech-to-text and may contain phonetic misrecognitions of proper names. Fix only those misrecognitions, against the known-name lists below. Do nothing else.

KNOWN PLAYER CHARACTERS: ${known.characters.join(', ') || '(none)'}
KNOWN NPCS: ${known.npcs.join(', ') || '(none)'}
KNOWN LOCATIONS: ${known.locations.join(', ') || '(none)'}

RULES:
1. Replace ONLY words that are clearly misrecognitions of one of the known names above (judged phonetically and by context). Examples: "terrain" or "train" -> "Thrain"; "bream" -> "Breme"; "merry dio" or "meridian" -> "Meridio".
2. Do NOT make any other edits. Preserve every line, every [HH:MM:SS] timestamp, every speaker label, every classification tag (e.g. [IN_GAME]), every scene break marker, and every blank line exactly as-is.
3. Do NOT add commentary, headings, explanations, or markdown code fences.
4. Do NOT replace ordinary words just because they slightly resemble a name. When in doubt, leave the original word unchanged.
5. Output ONLY the full corrected transcript text, with no preamble or trailing notes.

=== TRANSCRIPT ===
${transcript}`;

  // The corrector echoes the full transcript back, so output token
  // budget must roughly match the input length. Sonnet 4 supports up
  // to 64K output tokens; 32K comfortably handles a multi-hour session.
  const maxOut = 32768;

  try {
    const corrected = await callClaude(prompt, maxOut);
    if (!corrected || !corrected.trim()) {
      log.warn('Corrector returned empty result, falling back to original transcript');
      return transcript;
    }

    // Strip a leading/trailing markdown fence if Sonnet added one anyway
    let cleaned = corrected.trim();
    cleaned = cleaned.replace(/^```(?:[a-z]+)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

    // Sanity: the corrected output should be roughly comparable in length.
    // If it shrunk by more than 30%, something went wrong — fall back.
    if (cleaned.length < transcript.length * 0.7) {
      log.warn('Corrector output is suspiciously short, falling back to original', {
        originalLen: transcript.length,
        correctedLen: cleaned.length,
      });
      return transcript;
    }

    log.info('Transcript correction complete', {
      originalChars: transcript.length,
      correctedChars: cleaned.length,
      knownTerms: totalKnown,
    });
    return cleaned;
  } catch (err) {
    log.warn('Transcript correction failed (non-fatal)', { error: err.message });
    return transcript;
  }
}

module.exports = { correctTranscript, collectKnownTerms };
