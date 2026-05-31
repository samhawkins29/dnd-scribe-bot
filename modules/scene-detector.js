/**
 * Scene Marker Detector
 *
 * Inserts markdown-style scene markers into a transcript so the
 * downstream story generator can use them for chapter/scene structure.
 *
 *   [SCENE: <location name>]   — when the party moves to a new location
 *   [COMBAT START]             — when a fight begins
 *   [COMBAT END]               — when a fight resolves
 *   [SCENE: <descriptive name>] — for major narrative shifts
 *
 * Uses the shared Anthropic REST client (no SDK) — see
 * anthropic-client.js for the rationale.
 */

const log = require('../logger');
const { callClaude } = require('./anthropic-client');

// ─── Public API ──────────────────────────────────────────────────

/**
 * Insert scene/combat markers into a transcript.
 *
 * @param {string} transcript  The full transcript text.
 * @returns {Promise<string>}  Marked transcript (or original on failure).
 */
async function insertSceneMarkers(transcript) {
  if (!transcript || !transcript.trim()) return transcript;

  const prompt = `You are annotating a D&D (Dungeons & Dragons) session transcript with scene markers. Insert these markers on lines of their own at the exact positions where the boundaries occur:

- [SCENE: <location name>]    — when the party moves to a new location ("we head to the tavern", "you enter the dungeon", "we travel back to camp"). Use a short, descriptive location name in place of <location name>.
- [COMBAT START]              — when a fight begins ("roll initiative", "the goblins attack", "draw your weapons").
- [COMBAT END]                — when a fight resolves ("the last goblin falls", "the battle is over", "you have defeated them").
- [SCENE: <descriptive name>] — for major narrative shifts that aren't a new location (e.g., a long planning conversation, a flashback, a vision).

RULES:
1. Insert each marker on its OWN LINE at the exact spot in the transcript where the boundary occurs.
2. Do NOT modify, delete, paraphrase, reorder, or merge any existing line. Preserve every [HH:MM:SS] timestamp, every speaker label, every classification tag, every existing scene break marker, every blank line.
3. Do NOT add any commentary, explanations, headings, or markdown code fences around the output.
4. Be selective. Only insert a marker when there is clear, direct evidence in the transcript. Do not invent transitions to make the story flow better.
5. It is fine — and often correct — for a transcript to have only one or two markers, or none at all. Quality over quantity.
6. Output ONLY the entire transcript with markers inserted, and nothing else.

=== TRANSCRIPT ===
${transcript}`;

  // The scene detector echoes the full transcript back with markers
  // inserted, so output token budget must roughly match the input
  // length. Sonnet 4 supports up to 64K output tokens; 32K comfortably
  // handles a multi-hour session.
  const maxOut = 32768;

  try {
    const marked = await callClaude(prompt, maxOut);
    if (!marked || !marked.trim()) {
      log.warn('Scene detector returned empty result, falling back to unmarked transcript');
      return transcript;
    }

    // Strip stray markdown fences if any
    let cleaned = marked.trim();
    cleaned = cleaned.replace(/^```(?:[a-z]+)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

    // Sanity: the marked transcript should never be substantially shorter
    // than the original (Sonnet should only add lines).
    if (cleaned.length < transcript.length * 0.85) {
      log.warn('Scene detector output is suspiciously short, falling back', {
        originalLen: transcript.length,
        markedLen: cleaned.length,
      });
      return transcript;
    }

    const sceneCount = (cleaned.match(/\[SCENE:[^\]]+\]/g) || []).length;
    const combatStartCount = (cleaned.match(/\[COMBAT START\]/g) || []).length;
    const combatEndCount = (cleaned.match(/\[COMBAT END\]/g) || []).length;

    log.info('Scene markers inserted', {
      sceneCount,
      combatStartCount,
      combatEndCount,
    });
    return cleaned;
  } catch (err) {
    log.warn('Scene marker insertion failed (non-fatal)', { error: err.message });
    return transcript;
  }
}

module.exports = { insertSceneMarkers };
