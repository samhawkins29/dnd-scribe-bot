/**
 * D&D Scribe Bot — Transcript Line Classifier
 *
 * Pre-processes a session transcript to classify each line as one of:
 *   IN_GAME    — Character dialogue, actions, DM narration, in-character speech
 *   META       — Rules discussion, dice rolls, game mechanics
 *   OOC        — Out-of-character chat, real-world talk, breaks, tech issues
 *   NARRATION  — DM describing environments, NPCs, or events
 *
 * This classification step sits between speaker labeling and story generation,
 * giving the story generator structured input so it can filter content accurately.
 *
 * Uses the shared streaming Anthropic REST client (anthropic-client.js) rather
 * than the non-streaming SDK so long generations don't die as idle-socket
 * "fetch failed" errors, and so transient 429/5xx are retried.
 *
 * Long transcripts are split into line-aligned chunks before classification.
 * Each chunk is classified independently, so a multi-hour session can never be
 * silently truncated by a single response's output-token budget — the previous
 * single-call approach capped output at 8192 tokens and dropped the back half
 * of any long session while still passing the tag-rate check.
 */

const config = require('./config');
const log = require('./logger');
const { callClaude } = require('./modules/anthropic-client');

// Max input characters per classification chunk. Kept well below the output
// budget: tagging adds ~11 chars/line, so a chunk this size produces an output
// comfortably under transcriptMaxTokens (≈32K tokens ≈ ~120K chars).
const CHUNK_CHAR_BUDGET = 24000;

const PROMPT_HEADER = `You are a transcript classifier for a D&D (Dungeons & Dragons) tabletop session. Your task is to classify each line of the following transcript into exactly one of four categories:

- IN_GAME: Character dialogue, character actions, in-character speech, player decisions that advance the story (e.g., "I search the room for traps", "I attack the goblin")
- META: Rules discussion, dice rolls, game mechanics talk (e.g., "What do I roll for that?", "That's a DC 15", "I got a 17", "Does sneak attack apply?", "Roll initiative")
- OOC: Out-of-character chat, real-world conversation, food/drink/bathroom breaks, technical issues, scheduling, jokes about real life (e.g., "Hold on, my mic is muted", "Should we order pizza?", "I'll be right back")
- NARRATION: DM/Game Master describing environments, NPC actions, scene-setting, world-building, or narrating outcomes of actions (e.g., "You see a dark corridor stretching ahead", "The goblin lunges at you with its rusty blade")

RULES:
1. Prefix every line with its tag in square brackets: [IN_GAME], [META], [OOC], or [NARRATION]
2. Keep the original line content exactly as-is after the tag
3. If a line contains mixed content (e.g., in-game action followed by a rules question), classify based on the PRIMARY purpose of the line
4. DM lines that describe what happens as a result of player actions are [NARRATION]
5. DM lines where the DM is speaking AS an NPC (in-character NPC dialogue) are [IN_GAME]
6. Lines with timestamps like [HH:MM:SS] should keep the timestamp — put the tag before it
7. Every single line must be classified — do not skip or omit any lines
8. Preserve blank lines and scene break markers (like "--- SCENE BREAK ---") as-is without tags

Return ONLY the tagged transcript with no additional commentary or explanation.

=== TRANSCRIPT ===
`;

/**
 * Split a transcript into line-aligned chunks, each at most CHUNK_CHAR_BUDGET
 * characters. Splitting only on line boundaries means no line is ever cut in
 * half, and the per-line classification semantics are preserved across chunks.
 */
function chunkTranscript(transcript, budget = CHUNK_CHAR_BUDGET) {
  const lines = transcript.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the newline
    // A single line longer than the budget gets its own chunk rather than
    // being dropped or split mid-line.
    if (currentLen > 0 && currentLen + lineLen > budget) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * Fraction of non-empty lines in `text` that begin with a classification tag.
 */
function tagRate(text) {
  const taggedLines = text.split('\n').filter(l => l.trim());
  if (taggedLines.length === 0) return { rate: 0, taggedCount: 0, total: 0 };
  const taggedCount = taggedLines.filter(l =>
    /^\[(IN_GAME|META|OOC|NARRATION)\]/.test(l)
  ).length;
  return { rate: taggedCount / taggedLines.length, taggedCount, total: taggedLines.length };
}

/**
 * Classify a single chunk. Returns the tagged chunk, or the original chunk
 * (untagged) if the model output is empty, low-quality, or suspiciously short.
 * Never returns less content than it was given.
 */
async function classifyChunk(chunk, index, total) {
  if (!chunk.trim()) return chunk; // all-blank chunk — nothing to classify

  const prompt = PROMPT_HEADER + chunk;
  const tagged = await callClaude(prompt, config.anthropic.transcriptMaxTokens, {
    model: config.anthropic.model,
  });

  if (!tagged || !tagged.trim()) {
    log.warn('Classifier chunk returned empty result, keeping original chunk', {
      chunk: index + 1, of: total,
    });
    return chunk;
  }

  // Strip a leading/trailing markdown fence if the model added one anyway.
  let cleaned = tagged.trim();
  cleaned = cleaned.replace(/^```(?:[a-z]+)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  // Shrink guard: tagging only ever adds characters, so a correct response is
  // at least as long as the input. If it came back materially shorter it was
  // truncated or mangled — keep the original chunk so no content is lost.
  if (cleaned.length < chunk.length * 0.9) {
    log.warn('Classifier chunk output suspiciously short, keeping original chunk', {
      chunk: index + 1, of: total,
      originalLen: chunk.length,
      taggedLen: cleaned.length,
    });
    return chunk;
  }

  const { rate, taggedCount, total: lineCount } = tagRate(cleaned);
  if (rate < 0.5) {
    log.warn('Classifier chunk has low tag rate, keeping original chunk', {
      chunk: index + 1, of: total,
      taggedCount, totalLines: lineCount, tagRate: rate.toFixed(2),
    });
    return chunk;
  }

  return cleaned;
}

/**
 * Classify each line of a D&D session transcript into content categories.
 *
 * Splits the transcript into line-aligned chunks and classifies each via
 * Claude (Sonnet, for speed/cost). On any per-chunk failure it falls back to
 * that chunk's original (untagged) text rather than dropping content, so the
 * full session always survives the pass.
 *
 * @param {string} transcript  The raw transcript text (with speaker labels and timestamps)
 * @returns {Promise<string>}  The transcript with each line prefixed by its classification tag
 */
async function classifyTranscriptLines(transcript) {
  if (!transcript || !transcript.trim()) {
    log.warn('Empty transcript passed to classifier');
    return transcript;
  }

  const chunks = chunkTranscript(transcript);
  log.info('Classifying transcript lines', {
    lineCount: transcript.split('\n').filter(l => l.trim()).length,
    chars: transcript.length,
    chunks: chunks.length,
  });

  try {
    const tagged = [];
    for (let i = 0; i < chunks.length; i++) {
      tagged.push(await classifyChunk(chunks[i], i, chunks.length));
    }
    const result = tagged.join('\n');

    const { rate, taggedCount, total } = tagRate(result);
    log.info('Transcript classification complete', {
      chunks: chunks.length,
      totalLines: total,
      taggedLines: taggedCount,
      tagRate: rate.toFixed(2),
    });

    return result;
  } catch (err) {
    log.warn('Transcript classification failed, falling back to unclassified transcript', {
      error: err.message,
    });
    return transcript;
  }
}

module.exports = { classifyTranscriptLines, chunkTranscript };
