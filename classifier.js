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
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const log = require('./logger');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Classify each line of a D&D session transcript into content categories.
 *
 * Makes a Claude API call (using Sonnet for speed/cost since this is
 * classification, not creative writing) to tag each line with:
 *   [IN_GAME]   — Character dialogue, actions, in-character speech
 *   [META]      — Rules discussion, dice rolls, game mechanics
 *   [OOC]       — Out-of-character chat, real-world talk, breaks, tech issues
 *   [NARRATION] — DM describing environments, NPCs, or events
 *
 * @param {string} transcript  The raw transcript text (with speaker labels and timestamps)
 * @returns {Promise<string>}  The transcript with each line prefixed by its classification tag
 */
async function classifyTranscriptLines(transcript) {
  if (!transcript || !transcript.trim()) {
    log.warn('Empty transcript passed to classifier');
    return transcript;
  }

  const classificationPrompt = `You are a transcript classifier for a D&D (Dungeons & Dragons) tabletop session. Your task is to classify each line of the following transcript into exactly one of four categories:

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
${transcript}`;

  try {
    log.info('Classifying transcript lines', {
      lineCount: transcript.split('\n').filter(l => l.trim()).length,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: config.anthropic.maxTokens,
      messages: [{ role: 'user', content: classificationPrompt }],
    });

    const taggedTranscript = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    if (!taggedTranscript.trim()) {
      log.warn('Classifier returned empty result, falling back to unclassified transcript');
      return transcript;
    }

    // Validate that the output actually has classification tags
    const taggedLines = taggedTranscript.split('\n').filter(l => l.trim());
    const taggedCount = taggedLines.filter(l =>
      /^\[(IN_GAME|META|OOC|NARRATION)\]/.test(l)
    ).length;

    const tagRate = taggedLines.length > 0 ? taggedCount / taggedLines.length : 0;

    if (tagRate < 0.5) {
      log.warn('Classifier output has low tag rate, falling back to unclassified transcript', {
        taggedCount,
        totalLines: taggedLines.length,
        tagRate: tagRate.toFixed(2),
      });
      return transcript;
    }

    log.info('Transcript classification complete', {
      totalLines: taggedLines.length,
      taggedLines: taggedCount,
      tagRate: tagRate.toFixed(2),
    });

    return taggedTranscript;
  } catch (err) {
    log.warn('Transcript classification failed, falling back to unclassified transcript', {
      error: err.message,
    });
    return transcript;
  }
}

module.exports = { classifyTranscriptLines };
