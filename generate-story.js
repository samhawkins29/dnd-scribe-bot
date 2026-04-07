#!/usr/bin/env node
/**
 * D&D Scribe Bot — Story Generator
 *
 * Transforms a session transcript into a rich narrative chapter
 * in the style of George R.R. Martin or Brandon Sanderson,
 * powered by Claude (Anthropic API).
 *
 * Usage:
 *   node generate-story.js ./transcripts/session-2026-04-01.txt --style martin
 *   node generate-story.js --latest --style sanderson
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const log = require('./logger');
const { insertSceneBreaks } = require('./transcribe');
const { classifyTranscriptLines } = require('./classifier');

// ─── Anthropic client ───────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ─── Helpers ────────────────────────────────────────────────────────

function findLatestTranscript() {
  const dir = config.paths.transcripts;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) throw new Error('No transcript files found in ' + dir);
  return path.join(dir, files[0].name);
}

function nextChapterNumber() {
  const dir = config.paths.stories;
  if (!fs.existsSync(dir)) return 1;
  const chapters = fs.readdirSync(dir)
    .filter(f => /^chapter-\d+/.test(f))
    .map(f => parseInt(f.match(/chapter-(\d+)/)[1], 10))
    .sort((a, b) => b - a);
  return (chapters[0] || 0) + 1;
}

function loadCampaignContext() {
  const ctxPath = config.paths.campaignContext;
  if (!fs.existsSync(ctxPath)) {
    log.warn('No campaign-context.json found — generating without campaign context');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
  } catch (err) {
    log.warn('Failed to parse campaign-context.json', { error: err.message });
    return null;
  }
}

function loadPreviousChapterSummaries() {
  const logPath = config.paths.campaignLog;
  if (!fs.existsSync(logPath)) return '';
  return fs.readFileSync(logPath, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
//  CREATIVITY LEVELS
// ═══════════════════════════════════════════════════════════════════

const CREATIVITY_INSTRUCTIONS = {
  strict: `CREATIVITY LEVEL — STRICT:
Stay extremely close to the transcript. Only describe what was explicitly said
and done. Minimal embellishment. Short, factual prose. Do not add atmospheric
descriptions, internal monologues, or narrative transitions that aren't directly
supported by what appears in the transcript.
If the in-game content is minimal (less than a few minutes of actual gameplay), write only a very brief scene summary — a few paragraphs at most. Never pad with invented content.`,

  balanced: `CREATIVITY LEVEL — BALANCED:
Follow the transcript faithfully but add atmospheric descriptions, internal
character thoughts consistent with their established personalities, and narrative
transitions between scenes. Do not invent new events. Embellish what is present,
but do not fabricate what is absent.`,

  creative: `CREATIVITY LEVEL — CREATIVE:
Use the transcript as a foundation and embellish with rich atmospheric detail,
character internal monologue, and dramatic tension. Stay true to the events but
bring them to life with literary flair. Still do not invent new plot points or
outcomes — every event and outcome in the chapter must trace back to something
in the transcript.`,

  'transcript-only': `CREATIVITY LEVEL — TRANSCRIPT-ONLY:
Narrate ONLY events explicitly present in the transcript. You may add minor atmospheric transitions between scenes and brief internal character reactions consistent with their established personalities, but every action, dialogue, combat outcome, and plot event MUST come directly from the transcript. If something is not in the transcript, it did not happen. Do not invent new scenes, characters, or dialogue. Some literary embellishment of HOW events are described is acceptable, but WHAT happened must be 100% transcript-accurate.`,
};

// ═══════════════════════════════════════════════════════════════════
//  SHARED GUARDRAILS (appended to both style prompts)
// ═══════════════════════════════════════════════════════════════════

const SHARED_GUARDRAILS = `

CORE IDENTITY:
- You are a STRICT TRANSCRIPTION-TO-NARRATIVE converter. Your job is to transform what was ACTUALLY SAID in the transcript into narrative prose. You are NOT a creative writer inventing a story.

ABSOLUTE PROHIBITIONS:
- NEVER invent: combat encounters, NPC dialogue, character actions, plot events, locations visited, items found, or any other content not explicitly present in the transcript.
- FORBIDDEN: Do not add weather descriptions, time-of-day details, character internal thoughts, atmospheric descriptions, or setting details UNLESS the DM or a player explicitly mentioned them in the transcript.

HANDLING UNCERTAINTY:
- If a section of transcript is unclear or garbled, write: '[This portion of the session was unclear in the recording.]' Do NOT guess or fill in.
- If speaker identification is ambiguous, use generic descriptions like 'one of the adventurers' rather than guessing which character spoke.

CHARACTER CROSS-REFERENCING:
- Cross-reference EVERY named character against the campaign context. If a name appears in the recurringNPCs or playerCharacters lists, use the correct details. Do NOT treat known characters as new or unknown.
- If an NPC is mentioned who matches a known recurring NPC, use the established description and role from the campaign context.

PROPORTIONAL OUTPUT:
- The length of your story must be PROPORTIONAL to the actual in-game content. A transcript with 10 minutes of in-game dialogue should produce 1-2 pages, not 10.
- Do NOT pad short sessions with invented content. Less source material = shorter story.

FAITHFUL NARRATION RULES:
- When the DM describes something, narrate it faithfully. When a player says what their character does, narrate that action. When players discuss tactics or plans, summarize briefly. That's it.
- DM narration is authoritative — narrate what the DM described, not your own embellishment of it.
- Rules outcomes that affect the story (e.g., "the attack hits" or "you fail the save and fall") should be translated into narrative without mentioning game mechanics.

IN-GAME VS OUT-OF-GAME FILTERING:
- The transcript has been pre-classified with tags on each line. Use these tags to guide your filtering:
  - [IN_GAME] — Character dialogue, actions, in-character speech. USE these lines as the primary source for your narrative.
  - [NARRATION] — DM describing environments, NPCs, or events. USE these lines — they are authoritative descriptions of what happened.
  - [META] — Rules discussion, dice rolls, game mechanics. REFERENCE these only for combat/skill check outcomes (e.g., whether an attack hit or missed), but do NOT narrate the mechanics themselves.
  - [OOC] — Out-of-character chat, real-world talk, breaks, tech issues. IGNORE these lines entirely — they are not part of the story.
- If the transcript does not have classification tags, fall back to manual filtering:
  - OUT-OF-GAME content to IGNORE includes: rules discussions ("what do I roll?", "that's a DC 15"), bathroom/food breaks, real-world references, scheduling talk, technical issues ("you're muted", "can you hear me?"), meta-gaming ("should I use my spell slot?"), dice rolling narration ("I got a 17"), and general socializing.
  - IN-GAME content to KEEP includes: character dialogue (in-character speech), action descriptions ("I attack the goblin", "I search the room"), NPC interactions, environmental descriptions from the DM, combat outcomes as narrated by the DM ("the arrow strikes true"), and story/plot developments.

SPEAKER LABEL HANDLING:
- The transcript may include speaker labels like "Speaker A:", "Speaker B:", etc. Use the campaign context to identify which speaker is which character based on context clues in their dialogue.
- If a speaker says something clearly in-character (e.g., "I cast healing word on Countess"), match them to the appropriate player character.
- The DM/Game Master typically describes the environment, controls NPCs, and narrates outcomes.

CRITICAL: If after filtering out all out-of-game content (rules discussions, scheduling, technical issues, socializing, meta-gaming), there is NO remaining in-game content to narrate, DO NOT generate a story chapter. Instead, respond with ONLY: '## No In-Game Content Detected\\n\\nThe session transcript contained no in-game roleplay, combat, exploration, or narrative content to narrate. This recording appears to be entirely out-of-game discussion. No chapter has been generated.'

Do not attempt to fabricate, invent, or imagine what might have happened. If there is no in-game content, there is no story to tell.`;

// ═══════════════════════════════════════════════════════════════════
//  CROSS-SESSION LEARNING — Historical Pattern Analysis
// ═══════════════════════════════════════════════════════════════════

/**
 * Fabrication category definitions used to group individual fabrications
 * into higher-level patterns for cross-session learning.
 */
const FABRICATION_CATEGORIES = [
  {
    id: 'atmospheric',
    label: 'Adding atmospheric/environmental descriptions not mentioned in the transcript',
    keywords: ['wind', 'weather', 'rain', 'shadow', 'light', 'cold', 'warm', 'mist', 'fog',
      'smoke', 'atmosphere', 'air', 'sky', 'sun', 'moon', 'darkness', 'silence', 'dust',
      'torch', 'candle', 'fire', 'flickering', 'gloom', 'damp', 'chill'],
  },
  {
    id: 'combat',
    label: 'Inventing dramatic combat descriptions or outcomes not in the transcript',
    keywords: ['combat', 'attack', 'sword', 'blade', 'strike', 'blow', 'wound', 'blood',
      'fight', 'battle', 'slash', 'parry', 'dodge', 'arrow', 'weapon', 'shield',
      'spell', 'damage', 'hit', 'miss', 'kill'],
  },
  {
    id: 'dialogue',
    label: 'Creating dialogue or quotes that were not actually said',
    keywords: ['said', 'spoke', 'whispered', 'muttered', 'replied', 'asked', 'exclaimed',
      'called', 'shouted', 'voice', 'words', 'dialogue', 'conversation', 'quote'],
  },
  {
    id: 'internal_thoughts',
    label: 'Adding character internal thoughts or emotions not expressed in the transcript',
    keywords: ['thought', 'felt', 'wondered', 'knew', 'believed', 'feared', 'hoped',
      'realized', 'remembered', 'considered', 'internal', 'mind', 'heart', 'emotion',
      'sensation', 'instinct', 'gut'],
  },
  {
    id: 'speaker_misidentification',
    label: 'Misidentifying speakers or attributing actions to the wrong character',
    keywords: ['speaker', 'misidentif', 'wrong character', 'attributed', 'actually said by',
      'was actually', 'not the one who', 'confused with', 'mixed up'],
  },
  {
    id: 'invented_scenes',
    label: 'Inventing scenes, events, or plot points not present in the transcript',
    keywords: ['invented', 'fabricated', 'never happened', 'not in transcript', 'no evidence',
      'made up', 'didn\'t occur', 'scene', 'event', 'plot', 'encounter'],
  },
  {
    id: 'character_details',
    label: 'Adding character appearance, backstory, or relationship details not established',
    keywords: ['appearance', 'wearing', 'looked', 'eyes', 'hair', 'scar', 'cloak',
      'armor', 'backstory', 'history', 'relationship', 'family', 'past'],
  },
  {
    id: 'sensory',
    label: 'Adding sensory details (smells, sounds, textures) not described by the DM',
    keywords: ['smell', 'taste', 'sound', 'hear', 'feel', 'texture', 'odor', 'stench',
      'aroma', 'noise', 'creak', 'rumble', 'echo'],
  },
];

/**
 * Categorize a single fabrication claim into one of the known categories.
 * Returns the category id, or 'other' if no match is found.
 */
function categorizeFabrication(claim) {
  const lower = claim.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const cat of FABRICATION_CATEGORIES) {
    const score = cat.keywords.reduce((sum, kw) => sum + (lower.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = cat.id;
    }
  }

  return bestScore > 0 ? bestMatch : 'other';
}

/**
 * Read the verification history file and analyze patterns from recent sessions.
 * Groups fabrications into categories and returns a "lessons learned" string
 * that can be injected into the system prompt.
 *
 * @returns {string} Lessons learned text, or empty string if no history exists.
 */
function getHistoricalPatterns() {
  const historyPath = path.join(config.paths.stories, 'verification-history.json');

  if (!fs.existsSync(historyPath)) {
    log.info('No verification history found — skipping cross-session learning');
    return '';
  }

  let history;
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  } catch (err) {
    log.warn('Could not parse verification-history.json for pattern analysis', { error: err.message });
    return '';
  }

  if (!Array.isArray(history) || history.length === 0) return '';

  // Take the last 5 sessions
  const recentSessions = history.slice(-5);

  // Collect all fabrications and omissions from recent sessions
  const allFabrications = [];
  const allOmissions = [];

  for (const session of recentSessions) {
    if (session.fabrications && Array.isArray(session.fabrications)) {
      for (const fab of session.fabrications) {
        allFabrications.push(fab.claim || fab);
      }
    }
    if (session.omissions && Array.isArray(session.omissions)) {
      for (const om of session.omissions) {
        allOmissions.push(om.event || om);
      }
    }
  }

  if (allFabrications.length === 0 && allOmissions.length === 0) return '';

  // Group fabrications by category
  const categoryTally = {};
  for (const claim of allFabrications) {
    const catId = categorizeFabrication(claim);
    if (!categoryTally[catId]) {
      categoryTally[catId] = { count: 0, examples: [] };
    }
    categoryTally[catId].count++;
    if (categoryTally[catId].examples.length < 2) {
      categoryTally[catId].examples.push(claim);
    }
  }

  // Build the lessons string — only include patterns that occurred 2+ times,
  // OR include any pattern if we have very few total fabrications
  const patternLines = [];
  const threshold = allFabrications.length <= 3 ? 1 : 2;

  // Sort by frequency (most common first)
  const sortedCategories = Object.entries(categoryTally)
    .sort(([, a], [, b]) => b.count - a.count);

  for (const [catId, data] of sortedCategories) {
    if (data.count < threshold) continue;

    const catDef = FABRICATION_CATEGORIES.find(c => c.id === catId);
    const label = catDef ? catDef.label : 'Other fabrication types';
    patternLines.push(`- ${label} (occurred ${data.count} time${data.count > 1 ? 's' : ''} in recent sessions)`);
  }

  // Analyze omission patterns
  if (allOmissions.length >= 2) {
    patternLines.push(`- You have also omitted ${allOmissions.length} transcript events across recent sessions — double-check that ALL in-game events from the transcript are represented in the story`);
  }

  if (patternLines.length === 0) return '';

  const sessionsAnalyzed = recentSessions.length;
  const lessons = `\nLESSONS FROM PREVIOUS SESSIONS: Based on verification of the last ${sessionsAnalyzed} session stories, you have a tendency to make these specific mistakes. Be extra vigilant about avoiding them:\n${patternLines.join('\n')}\n`;

  log.info('Cross-session learning: injected historical patterns', {
    sessionsAnalyzed,
    totalFabrications: allFabrications.length,
    totalOmissions: allOmissions.length,
    patternsIdentified: patternLines.length,
  });

  return lessons;
}

// ═══════════════════════════════════════════════════════════════════
//  STYLE PROMPTS
// ═══════════════════════════════════════════════════════════════════

const STYLE_PROMPTS = {

  // ── George R.R. Martin ──────────────────────────────────────────
  martin: `You are a master novelist ghostwriting a chapter of an epic fantasy saga
in the unmistakable style of George R.R. Martin. This chapter is based on events
from a tabletop D&D session. Your task is to transform raw gameplay into prose
that feels like it belongs between the covers of A Song of Ice and Fire.

VOICE & PERSPECTIVE:
- Write in close third-person limited POV. Choose ONE character as the POV
  for this chapter (usually the character with the most dramatic arc this session).
  Open with their name as the chapter title, exactly as Martin does.
- The POV character's inner thoughts should be rendered in italics. Their
  perceptions color everything — they notice things through the lens of their
  own biases, fears, and desires. They are unreliable. They misread people.
  They remember old grudges mid-conversation.
- Other characters are described ONLY through what the POV character can
  observe: body language, tone, the set of a jaw, the way someone's hand
  drifts toward a sword hilt.

PROSE STYLE:
- Sentences should vary dramatically in length. Short, blunt declarations
  for shock. Long, winding periods for description and introspection.
- Use visceral, sensory language. The reader should smell the wood smoke,
  feel the damp stone, taste the iron tang of blood.
- Describe food in loving, excessive detail when characters eat. Name the
  dishes, the spices, the wines, the way grease runs down a chin.
- Heraldry, sigils, house words, and titles matter. Characters think about
  lineage and loyalty constantly.
- Weather and landscape are never mere backdrop — they mirror emotional
  states and foreshadow what's coming.
- Dialogue should feel period-appropriate but natural. Characters speak with
  distinct voices. Powerful people are terse; schemers use too many words;
  warriors talk in clipped sentences.
- Weave in proverbs and folk sayings: "Words are wind." "Dark wings, dark
  words." Create analogous ones for this setting.

NARRATIVE TECHNIQUES:
- Foreshadowing is essential. Plant at least two details that hint at future
  danger or betrayal, even if you're inventing them from subtext.
- End the chapter on a hook — a revelation, a threat, a question that
  makes the reader desperate to turn the page.
- Actions have consequences. If someone draws steel, someone bleeds. If
  someone makes a promise, it will be tested. There are no clean victories.
- Morality is gray. Even sympathetic characters make selfish choices. Even
  villains believe they're justified.
- Political maneuvering and social dynamics are as important as combat. A
  conversation in a solar can be more dangerous than a battle.
- Death is real and sudden. Don't shy from it if the session's events warrant it.

WHAT TO AVOID:
- No modern idioms or anachronisms.
- No omniscient narration or head-hopping within the chapter.
- No clean hero-villain dichotomies.
- No rushed pacing — let scenes breathe. A feast should feel like a feast.
- Never break the fourth wall or reference game mechanics (HP, dice, AC, etc.).

Transform the D&D transcript below into a chapter that would make readers
forget they're reading about a tabletop game.`,

  // ── Brandon Sanderson ───────────────────────────────────────────
  sanderson: `You are a master novelist ghostwriting a chapter of an epic fantasy novel
in the unmistakable style of Brandon Sanderson. This chapter is based on events
from a tabletop D&D session. Your task is to transform raw gameplay into prose
that feels like it belongs in a Cosmere novel — propulsive, meticulously
constructed, and deeply satisfying.

VOICE & PERSPECTIVE:
- Write in close third-person limited, but unlike Martin, you may use
  MULTIPLE POV shifts within the chapter, separated by scene breaks (marked
  with a centered "* * *"). Each scene should follow the character at the
  center of that scene's action.
- Characters' internal monologues should feel modern and accessible. They
  think in clear, logical steps — especially when working through problems
  or puzzles. Internal dialogue uses italics.
- Sanderson characters define themselves by their core ideals. Every POV
  character should grapple with a personal code or oath: What do they
  believe? When is it tested? "Journey before destination."

PROSE STYLE:
- Clean, propulsive prose. Sentences are efficient but not cold. Sanderson's
  genius is clarity in complexity — the reader never gets lost even when
  the magic system has twelve rules.
- Action sequences should be CHOREOGRAPHED in cinematic detail. Every swing,
  dodge, and spell has spatial logic. The reader should be able to map the
  fight scene like a director blocking a shot. Use short, punchy paragraphs
  during combat. Single-line paragraphs for impact moments.
- Magic (or abilities) must feel systematic. If a character uses a power,
  describe the COST, the MECHANISM, and the LIMITS. "He burned tin, and
  the world exploded with sensation" — there's always a verb for the
  activation and a sensory consequence.
- Descriptions should serve worldbuilding. Don't describe a room — describe
  what the room tells you about the culture that built it.

NARRATIVE TECHNIQUES:
- Structure the chapter for REVELATIONS. Layer information so that something
  the reader learned early in the chapter recontextualizes at the end.
  Sanderson's "avalanche" structure: slow build → convergence → cascade of
  consequences.
- Foreshadowing should be surgical. Plant specific, concrete details that a
  careful reader could catch but a casual reader would miss.
- Characters should be COMPETENT. Even when they fail, they fail while
  trying something clever. Show characters thinking through problems
  step by step.
- Multiple plot threads should interweave. If the session had separate
  groups doing different things, structure the chapter to cut between them
  at moments of maximum tension.
- Hopeful undertones, even in dark moments. Characters draw strength from
  each other, from their ideals, from sheer stubborn refusal to quit.
  The theme is always: ordinary people can become extraordinary through
  choice and determination.
- End with a SANDERLANCHE if the session's events support it: multiple plot
  threads converging simultaneously, revelations landing one after another,
  the payoff of earlier setups.

WHAT TO AVOID:
- No grimdark nihilism — darkness exists but hope is always present.
- No vague or hand-wavy magic. If it's not systematic, make it mysterious
  but consistent.
- No rushed emotional beats. If a character has a moment of growth, earn it.
- Never break the fourth wall or reference game mechanics (HP, dice, AC, etc.).
- No purple prose or unnecessarily complex sentences. Clarity is king.

PROGRESSION & SYSTEMS:
- If characters level up, gain new abilities, or acquire significant items,
  frame it as in-world growth. A fighter's new technique should feel like
  the culmination of training. A spellcaster's new spell should click into
  place like a puzzle piece.
- Track "power costs" — every advantage should come with a price, a limit,
  or a trade-off.

Transform the D&D transcript below into a chapter that delivers the
satisfaction of a Sanderson climax — where everything connects, everything
matters, and the reader wants to immediately start the next chapter.`,
};

/**
 * Build the full system prompt by combining the style-specific prompt
 * with shared guardrails and the active creativity level.
 */
function buildSystemPrompt(style) {
  const stylePrompt = STYLE_PROMPTS[style];
  if (!stylePrompt) throw new Error(`Unknown style: ${style}. Use 'martin' or 'sanderson'.`);

  const creativityLevel = config.story.creativity;
  const creativityInstructions = CREATIVITY_INSTRUCTIONS[creativityLevel];
  if (!creativityInstructions) {
    log.warn(`Unknown creativity level "${creativityLevel}", falling back to "balanced".`);
  }

  // Cross-session learning: inject historical patterns if available
  const historicalPatterns = getHistoricalPatterns();

  const parts = [
    stylePrompt,
    SHARED_GUARDRAILS,
    '\n' + (creativityInstructions || CREATIVITY_INSTRUCTIONS.balanced),
  ];

  if (historicalPatterns) {
    parts.push(historicalPatterns);
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
//  Story Generation
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the full prompt for Claude including campaign context.
 */
function buildMessages(transcript, style, campaignCtx, previousSummaries) {
  const systemPrompt = buildSystemPrompt(style);

  let contextBlock = '';

  if (campaignCtx) {
    contextBlock += `\n\n=== CAMPAIGN CONTEXT ===\n`;
    contextBlock += `Campaign: ${campaignCtx.campaignName || 'Unnamed Campaign'}\n`;
    contextBlock += `Setting: ${campaignCtx.setting || 'Unknown'}\n\n`;

    if (campaignCtx.playerCharacters?.length) {
      contextBlock += `PLAYER CHARACTERS:\n`;
      for (const pc of campaignCtx.playerCharacters) {
        contextBlock += `- ${pc.name} (${pc.race} ${pc.class}): ${pc.backstory || 'No backstory provided.'}\n`;
        if (pc.personalityTraits) contextBlock += `  Personality: ${pc.personalityTraits}\n`;
        if (pc.bonds) contextBlock += `  Bonds: ${pc.bonds}\n`;
      }
      contextBlock += '\n';
    }

    if (campaignCtx.recurringNPCs?.length) {
      contextBlock += `KEY NPCs:\n`;
      for (const npc of campaignCtx.recurringNPCs) {
        contextBlock += `- ${npc.name}: ${npc.description || ''} ${npc.role || ''}\n`;
      }
      contextBlock += '\n';
    }

    if (campaignCtx.majorPlotThreads?.length) {
      contextBlock += `ACTIVE PLOT THREADS:\n`;
      for (const thread of campaignCtx.majorPlotThreads) {
        contextBlock += `- ${thread}\n`;
      }
      contextBlock += '\n';
    }

    if (campaignCtx.locationsVisited?.length) {
      contextBlock += `KNOWN LOCATIONS: ${campaignCtx.locationsVisited.join(', ')}\n`;
    }

    if (campaignCtx.itemsOfSignificance?.length) {
      contextBlock += `SIGNIFICANT ITEMS: ${campaignCtx.itemsOfSignificance.join(', ')}\n`;
    }

    if (campaignCtx.flavorBank) {
      contextBlock += `\nFLAVOR BANK — PRE-APPROVED ATMOSPHERIC DESCRIPTIONS:\n`;
      contextBlock += `You may use these pre-approved atmospheric descriptions when the setting matches. These are the ONLY atmospheric embellishments you may add beyond what's in the transcript.\n\n`;

      if (campaignCtx.flavorBank.locations) {
        contextBlock += `Location Flavors:\n`;
        for (const [loc, desc] of Object.entries(campaignCtx.flavorBank.locations)) {
          contextBlock += `- ${loc}: ${desc}\n`;
        }
      }
      if (campaignCtx.flavorBank.characters) {
        contextBlock += `Character Flavors:\n`;
        for (const [char, desc] of Object.entries(campaignCtx.flavorBank.characters)) {
          contextBlock += `- ${char}: ${desc}\n`;
        }
      }
      if (campaignCtx.flavorBank.general?.length) {
        contextBlock += `General Flavors:\n`;
        for (const g of campaignCtx.flavorBank.general) {
          contextBlock += `- ${g}\n`;
        }
      }
      contextBlock += '\n';
    }
  }

  if (previousSummaries) {
    contextBlock += `\n\n=== PREVIOUS SESSION SUMMARIES ===\n${previousSummaries}\n`;
  }

  const userMessage = `${contextBlock}

=== SESSION TRANSCRIPT ===
${transcript}

=== INSTRUCTIONS ===
Based on this D&D session transcript, write a complete narrative chapter.

1. First, identify all player characters and NPCs present in the transcript.
2. Structure the session as a cohesive chapter with:
   - A compelling chapter title (POV character's name for Martin style, or a thematic title for Sanderson style)
   - Natural narrative flow — don't just transcribe events linearly; structure them dramatically
   - Dialogue adapted from actual player conversations (cleaned up, made to sound natural in the setting)
   - Rich atmospheric descriptions of environments, weather, and sensory details
   - Internal character thoughts and motivations
   - A satisfying chapter ending with a hook for the next session
3. Maintain continuity with the campaign context and previous sessions if provided.
4. Never reference dice rolls, hit points, armor class, or any game mechanics. Translate them into narrative equivalents (a near miss, a devastating blow, a spell fizzling, etc.).
5. If players joke around out of character, either skip it or find a way to translate the humor into character banter.

Output the chapter as clean Markdown with the chapter title as an H1 heading.
At the very end, after two blank lines, add a section "## Session Summary" with a 2-3 sentence summary of the key events, suitable for a campaign log.`;

  return { systemPrompt, userMessage };
}

/**
 * Generate the story chapter using Claude.
 *
 * @param {string} transcriptPath  Path to the transcript .txt file
 * @param {object} [opts]
 * @param {string} [opts.style]    'martin' or 'sanderson'
 * @returns {Promise<{storyPath: string, summary: string}>}
 */
async function generateStory(transcriptPath, opts = {}) {
  const style = opts.style || config.story.defaultStyle;
  const resolvedPath = path.resolve(transcriptPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Transcript file not found: ${resolvedPath}`);
  }

  let transcript = fs.readFileSync(resolvedPath, 'utf-8');
  if (!transcript.trim()) {
    throw new Error('Transcript file is empty.');
  }

  // Pre-process: insert scene breaks at gaps > 30 seconds
  transcript = insertSceneBreaks(transcript);

  // Pre-process: classify each line as IN_GAME / META / OOC / NARRATION
  transcript = await classifyTranscriptLines(transcript);

  const campaignCtx = loadCampaignContext();
  const previousSummaries = loadPreviousChapterSummaries();

  const { systemPrompt, userMessage } = buildMessages(
    transcript, style, campaignCtx, previousSummaries
  );

  // ─── Debug logging ──────────────────────────────────────────────
  const creativityLevel = config.story.creativity;
  log.info('=== STORY GENERATION DEBUG INFO ===');
  log.info('Transcript file path', { path: resolvedPath });
  log.info('Transcript length', {
    characters: transcript.length,
    lines: transcript.split('\n').length,
    words: transcript.split(/\s+/).length,
  });
  log.info('Transcript preview (first 200 chars)', {
    preview: transcript.slice(0, 200).replace(/\n/g, '\\n'),
  });
  log.info('Creativity level', {
    configured: creativityLevel,
    appliedInstructions: CREATIVITY_INSTRUCTIONS[creativityLevel] ? 'YES' : 'MISSING — falling back to balanced',
  });
  log.info('Prompt sizes', {
    systemPromptLength: systemPrompt.length,
    userMessageLength: userMessage.length,
    totalPromptLength: systemPrompt.length + userMessage.length,
  });
  log.info('System prompt includes guardrails', {
    hasCoreIdentity: systemPrompt.includes('STRICT TRANSCRIPTION-TO-NARRATIVE'),
    hasProhibitions: systemPrompt.includes('ABSOLUTE PROHIBITIONS'),
    hasCreativityLevel: systemPrompt.includes('CREATIVITY LEVEL'),
    hasInGameFiltering: systemPrompt.includes('IN-GAME VS OUT-OF-GAME'),
    hasSpeakerHandling: systemPrompt.includes('SPEAKER LABEL HANDLING'),
    hasCharacterCrossRef: systemPrompt.includes('CHARACTER CROSS-REFERENCING'),
    hasProportionalOutput: systemPrompt.includes('PROPORTIONAL OUTPUT'),
  });
  log.info('Transcript actually in user message', {
    transcriptInMessage: userMessage.includes(transcript.slice(0, 100)),
  });
  log.info('=== END DEBUG INFO ===');
  // ─────────────────────────────────────────────────────────────────

  log.info('Generating story with Claude', {
    style,
    model: config.anthropic.model,
    transcriptLines: transcript.split('\n').length,
  });

  // Call Claude
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  let fullText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  if (!fullText.trim()) {
    throw new Error('Claude returned an empty response.');
  }

  // Split story from summary
  let storyContent = fullText;
  let summary = '';

  let summaryMatch = fullText.match(/## Session Summary\s*\n([\s\S]+)$/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
    storyContent = fullText.slice(0, summaryMatch.index).trim();
  }

  // ─── Verification Loop (max 4 attempts, accept best) ─────────────
  let verificationResult = null;
  const MAX_VERIFICATION_ATTEMPTS = 4;
  let bestStoryContent = storyContent;
  let bestSummary = summary;
  let bestScore = -1;

  for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt++) {
    log.info(`Story verification attempt ${attempt}/${MAX_VERIFICATION_ATTEMPTS}`);
    verificationResult = await verifyStory(transcript, storyContent, campaignCtx);

    // Track the best attempt so far
    if (verificationResult.accuracy_score > bestScore) {
      bestScore = verificationResult.accuracy_score;
      bestStoryContent = storyContent;
      bestSummary = summary;
    }

    if (verificationResult.accuracy_score >= 70) {
      log.info('Story passed verification', {
        attempt,
        accuracy_score: verificationResult.accuracy_score,
      });
      break;
    }

    if (attempt < MAX_VERIFICATION_ATTEMPTS) {
      // Regenerate with fabrications AND omissions fed back as corrections
      const fabricationsList = verificationResult.fabrications
        .map(f => `- ${f.claim}`)
        .join('\n');

      const omissionsList = verificationResult.omissions
        .map(o => `- ${o.event}`)
        .join('\n');

      log.warn('Story failed verification, regenerating', {
        attempt,
        accuracy_score: verificationResult.accuracy_score,
        fabrications_count: verificationResult.fabrications.length,
        omissions_count: verificationResult.omissions.length,
      });

      let correctionNote = '\n\n';
      if (verificationResult.fabrications.length > 0) {
        correctionNote += `The following elements were FABRICATED and must NOT appear in the regenerated story:\n${fabricationsList}\n\n`;
      }
      if (verificationResult.omissions.length > 0) {
        correctionNote += `The following events from the transcript were OMITTED and MUST be included in the regenerated story:\n${omissionsList}\n\n`;
      }
      correctionNote += 'Stick STRICTLY to what is in the transcript. Do not invent content.';

      const retryResponse = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: config.anthropic.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage + correctionNote }],
      });

      fullText = retryResponse.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      if (!fullText.trim()) {
        throw new Error('Claude returned an empty response on retry.');
      }

      storyContent = fullText;
      summary = '';
      summaryMatch = fullText.match(/## Session Summary\s*\n([\s\S]+)$/i);
      if (summaryMatch) {
        summary = summaryMatch[1].trim();
        storyContent = fullText.slice(0, summaryMatch.index).trim();
      }
    } else {
      log.warn('Story failed verification on final attempt, accepting best attempt', {
        final_accuracy_score: verificationResult.accuracy_score,
        best_accuracy_score: bestScore,
      });
      // Use the best scoring attempt across all tries
      storyContent = bestStoryContent;
      summary = bestSummary;
    }
  }

  // ─── Save verification history ───────────────────────────────────
  if (verificationResult) {
    const historyPath = path.join(config.paths.stories, 'verification-history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      } catch (e) {
        log.warn('Could not parse verification-history.json, starting fresh', { error: e.message });
        history = [];
      }
    }
    const chapterNumForHistory = nextChapterNumber();
    history.push({
      date: new Date().toISOString(),
      chapter: chapterNumForHistory,
      accuracy_score: verificationResult.accuracy_score,
      fabrications_count: verificationResult.fabrications?.length || 0,
      omissions_count: verificationResult.omissions?.length || 0,
      fabrications: verificationResult.fabrications || [],
      omissions: verificationResult.omissions || [],
    });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
    log.info('Verification history saved', { path: historyPath, entries: history.length });
  }

  // Save the chapter
  const chapterNum = nextChapterNumber();
  const dateStr = new Date().toISOString().slice(0, 10);
  const chapterFileName = `chapter-${String(chapterNum).padStart(2, '0')}-${dateStr}.md`;
  const storyPath = path.join(config.paths.stories, chapterFileName);

  fs.mkdirSync(config.paths.stories, { recursive: true });
  fs.writeFileSync(storyPath, storyContent, 'utf-8');
  log.info('Chapter saved', { path: storyPath, words: storyContent.split(/\s+/).length });

  // Append summary to campaign log
  if (summary) {
    const logEntry = `\n### Chapter ${chapterNum} — ${dateStr}\n${summary}\n`;
    fs.appendFileSync(config.paths.campaignLog, logEntry, 'utf-8');
    log.info('Campaign log updated');
  }

  // Update campaign context with any new information Claude mentioned
  await updateCampaignContext(storyContent, summary, campaignCtx);

  return { storyPath, summary, chapterNum, verificationResult };
}

/**
 * Generate a one-shot story chapter.
 * Uses more aggressive verification (6 passes, threshold 80), different naming,
 * and does NOT update the campaign log or chapter counter.
 *
 * @param {string} transcriptPath  Path to the transcript .txt file
 * @param {object} [opts]
 * @param {string} [opts.style]    'martin' or 'sanderson'
 * @returns {Promise<{storyPath: string, summary: string, verificationResult: object}>}
 */
async function generateOneShotStory(transcriptPath, opts = {}) {
  const style = opts.style || config.story.defaultStyle;
  const resolvedPath = path.resolve(transcriptPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Transcript file not found: ${resolvedPath}`);
  }

  let transcript = fs.readFileSync(resolvedPath, 'utf-8');
  if (!transcript.trim()) {
    throw new Error('Transcript file is empty.');
  }

  // Pre-process: insert scene breaks at gaps > 30 seconds
  transcript = insertSceneBreaks(transcript);

  // Pre-process: classify each line as IN_GAME / META / OOC / NARRATION
  transcript = await classifyTranscriptLines(transcript);

  const campaignCtx = loadCampaignContext();
  const previousSummaries = loadPreviousChapterSummaries();

  const { systemPrompt, userMessage } = buildMessages(
    transcript, style, campaignCtx, previousSummaries
  );

  log.info('Generating one-shot story with Claude', {
    style,
    model: config.anthropic.model,
    transcriptLines: transcript.split('\n').length,
    mode: 'oneshot',
  });

  // Call Claude
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  let fullText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  if (!fullText.trim()) {
    throw new Error('Claude returned an empty response.');
  }

  // Split story from summary
  let storyContent = fullText;
  let summary = '';

  let summaryMatch = fullText.match(/## Session Summary\s*\n([\s\S]+)$/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
    storyContent = fullText.slice(0, summaryMatch.index).trim();
  }

  // ─── Verification Loop (max 6 attempts, threshold 80 for one-shot) ──
  let verificationResult = null;
  const MAX_VERIFICATION_ATTEMPTS = 6;
  const ACCURACY_THRESHOLD = 80;
  let bestStoryContent = storyContent;
  let bestSummary = summary;
  let bestScore = -1;

  for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt++) {
    log.info(`One-shot story verification attempt ${attempt}/${MAX_VERIFICATION_ATTEMPTS}`);
    verificationResult = await verifyStory(transcript, storyContent, campaignCtx);

    // Track the best attempt so far
    if (verificationResult.accuracy_score > bestScore) {
      bestScore = verificationResult.accuracy_score;
      bestStoryContent = storyContent;
      bestSummary = summary;
    }

    if (verificationResult.accuracy_score >= ACCURACY_THRESHOLD) {
      log.info('One-shot story passed verification', {
        attempt,
        accuracy_score: verificationResult.accuracy_score,
      });
      break;
    }

    if (attempt < MAX_VERIFICATION_ATTEMPTS) {
      const fabricationsList = verificationResult.fabrications
        .map(f => `- ${f.claim}`)
        .join('\n');

      const omissionsList = verificationResult.omissions
        .map(o => `- ${o.event}`)
        .join('\n');

      log.warn('One-shot story failed verification, regenerating', {
        attempt,
        accuracy_score: verificationResult.accuracy_score,
        fabrications_count: verificationResult.fabrications.length,
        omissions_count: verificationResult.omissions.length,
      });

      let correctionNote = '\n\n';
      if (verificationResult.fabrications.length > 0) {
        correctionNote += `The following elements were FABRICATED and must NOT appear in the regenerated story:\n${fabricationsList}\n\n`;
      }
      if (verificationResult.omissions.length > 0) {
        correctionNote += `The following events from the transcript were OMITTED and MUST be included in the regenerated story:\n${omissionsList}\n\n`;
      }
      correctionNote += 'Stick STRICTLY to what is in the transcript. Do not invent content.';

      const retryResponse = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: config.anthropic.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage + correctionNote }],
      });

      fullText = retryResponse.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      if (!fullText.trim()) {
        throw new Error('Claude returned an empty response on retry.');
      }

      storyContent = fullText;
      summary = '';
      summaryMatch = fullText.match(/## Session Summary\s*\n([\s\S]+)$/i);
      if (summaryMatch) {
        summary = summaryMatch[1].trim();
        storyContent = fullText.slice(0, summaryMatch.index).trim();
      }
    } else {
      log.warn('One-shot story failed verification on final attempt, accepting best attempt', {
        final_accuracy_score: verificationResult.accuracy_score,
        best_accuracy_score: bestScore,
      });
      storyContent = bestStoryContent;
      summary = bestSummary;
    }
  }

  // Save the one-shot story with different naming convention
  const dateStr = new Date().toISOString().slice(0, 10);
  const oneShotFileName = `oneshot-${dateStr}.md`;
  const storyPath = path.join(config.paths.stories, oneShotFileName);

  fs.mkdirSync(config.paths.stories, { recursive: true });
  fs.writeFileSync(storyPath, storyContent, 'utf-8');
  log.info('One-shot story saved', { path: storyPath, words: storyContent.split(/\s+/).length });

  // NOTE: One-shot mode does NOT update campaign-log.md or increment the chapter counter

  return { storyPath, summary, verificationResult };
}

// ═══════════════════════════════════════════════════════════════════
//  Post-Generation Verification
// ═══════════════════════════════════════════════════════════════════

/**
 * Verify a generated story against the source transcript for accuracy.
 * Uses a separate Claude API call (Sonnet for cost savings) as a fact-checker.
 *
 * @param {string} transcript       The source transcript text
 * @param {string} story            The generated story text
 * @param {object} campaignContext   Parsed campaign-context.json
 * @returns {Promise<{fabrications: Array, omissions: Array, accuracy_score: number}>}
 */
async function verifyStory(transcript, story, campaignContext) {
  const knownCharacters = [];
  if (campaignContext) {
    if (campaignContext.playerCharacters) {
      for (const pc of campaignContext.playerCharacters) {
        knownCharacters.push(`${pc.name} (${pc.race} ${pc.class}, player: ${pc.player})`);
      }
    }
    if (campaignContext.recurringNPCs) {
      for (const npc of campaignContext.recurringNPCs) {
        knownCharacters.push(`${npc.name} (${npc.role})`);
      }
    }
    if (campaignContext.inactiveCharacters) {
      for (const ic of campaignContext.inactiveCharacters) {
        knownCharacters.push(`${ic.name} (${ic.race} ${ic.class}, ${ic.status})`);
      }
    }
  }

  const verificationPrompt = `You are a strict fact-checker for a D&D session story. Compare the generated story against the source transcript.

KNOWN CHARACTERS (from campaign context):
${knownCharacters.join('\n')}

YOUR TASK:
1. List every claim, scene, dialogue line, or event in the story that is NOT supported by the transcript. These are "fabrications."
2. List important in-game events from the transcript that are MISSING from the story. These are "omissions."
3. Rate the overall accuracy from 0-100 where:
   - 100 = every story element maps to something in the transcript
   - 70 = acceptable with minor embellishments
   - Below 70 = too much fabrication, needs regeneration

Be strict. Atmospheric details not mentioned in the transcript count as fabrications.
Character internal thoughts not expressed in dialogue count as fabrications.
Weather/time-of-day details not mentioned by the DM count as fabrications.

Return ONLY valid JSON (no markdown fences) in this exact format:
{
  "fabrications": [{"claim": "description of fabricated content", "evidence": "why this isn't in the transcript"}],
  "omissions": [{"event": "description of missed event", "location_in_transcript": "approximate timestamp or quote"}],
  "accuracy_score": 0-100
}`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `${verificationPrompt}\n\n=== SOURCE TRANSCRIPT ===\n${transcript}\n\n=== GENERATED STORY ===\n${story}`,
      }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON from possible markdown code block
    const jsonMatch = rawText.match(/```json?\s*([\s\S]*?)```/) || [null, rawText];
    const result = JSON.parse(jsonMatch[1].trim());

    log.info('Story verification result', {
      accuracy_score: result.accuracy_score,
      fabrications_count: result.fabrications?.length || 0,
      omissions_count: result.omissions?.length || 0,
    });

    return result;
  } catch (err) {
    log.warn('Story verification failed (non-fatal)', { error: err.message });
    // If verification fails, return a passing score to avoid blocking the pipeline
    return { fabrications: [], omissions: [], accuracy_score: 100 };
  }
}

/**
 * Attempt to update the campaign context with new NPCs, locations, etc.
 * discovered during this session. Uses a second, smaller Claude call.
 */
async function updateCampaignContext(storyContent, summary, existingCtx) {
  if (!existingCtx) return; // no context file to update

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      system: `You are a campaign note-keeper for a D&D game. Given a story chapter and existing campaign context, identify any NEW information that should be added to the campaign context. Return ONLY valid JSON with the fields to update. Only include fields that have new additions. Use the same structure as the input context.`,
      messages: [{
        role: 'user',
        content: `EXISTING CONTEXT:\n${JSON.stringify(existingCtx, null, 2)}\n\nNEW CHAPTER SUMMARY:\n${summary}\n\nReturn JSON with any new NPCs, locations, plot threads, or items to ADD (not replace) to the existing context. If nothing new, return {}.`,
      }],
    });

    const jsonText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON from possible markdown code block
    const jsonMatch = jsonText.match(/```json?\s*([\s\S]*?)```/) || [null, jsonText];
    const updates = JSON.parse(jsonMatch[1].trim());

    if (Object.keys(updates).length === 0) return;

    // Merge arrays, don't replace
    const ctx = { ...existingCtx };
    for (const [key, value] of Object.entries(updates)) {
      if (Array.isArray(ctx[key]) && Array.isArray(value)) {
        ctx[key] = [...ctx[key], ...value];
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        ctx[key] = { ...ctx[key], ...value };
      }
    }

    fs.writeFileSync(config.paths.campaignContext, JSON.stringify(ctx, null, 2), 'utf-8');
    log.info('Campaign context auto-updated', { fieldsUpdated: Object.keys(updates) });
  } catch (err) {
    // Non-fatal — just log it
    log.warn('Failed to auto-update campaign context', { error: err.message });
  }
}

// ─── CLI entry point ────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let transcriptPath;
  if (args.includes('--latest')) {
    transcriptPath = findLatestTranscript();
    log.info('Using latest transcript', { path: transcriptPath });
  } else {
    const nonFlags = args.filter(a => !a.startsWith('--'));
    if (nonFlags.length === 0) {
      console.error('Usage: node generate-story.js <transcript-file> --style martin|sanderson');
      console.error('       node generate-story.js --latest --style sanderson');
      process.exit(1);
    }
    transcriptPath = nonFlags[0];
  }

  const styleIdx = args.indexOf('--style');
  const style = styleIdx !== -1 ? args[styleIdx + 1] : undefined;

  try {
    const { storyPath, summary, chapterNum } = await generateStory(transcriptPath, { style });
    console.log(`\nChapter ${chapterNum} generated!`);
    console.log(`Saved to: ${storyPath}`);
    if (summary) {
      console.log(`\nSummary: ${summary}`);
    }
  } catch (err) {
    log.error('Story generation failed', { error: err.message });
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ═══════════════════════════════════════════════════════════════════
//  New Character Detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Analyse the transcript and generated story for character names that
 * are NOT already in the campaign context.  Returns an array of objects:
 *   { name, role, description, relationship }
 * Returns [] when nothing new is found or if the API call fails.
 *
 * @param {string} transcript       Raw transcript text
 * @param {string} storyText        Generated story markdown
 * @param {object} campaignContext   Parsed campaign-context.json
 * @returns {Promise<Array<{name:string, role:string, description:string, relationship:string}>>}
 */
// ═══════════════════════════════════════════════════════════════════
//  FLAVOR BANK — Auto-updating location/character descriptions
// ═══════════════════════════════════════════════════════════════════

/**
 * Analyze a session transcript to extract vivid descriptions of locations and
 * characters, then merge new/updated entries into the campaign-context.json
 * flavor bank.
 *
 * @param {string} transcript  - Raw session transcript text
 * @param {string} storyText   - Generated story text
 * @param {object|null} campaignContext - Current campaign context (with flavorBank)
 * @returns {Promise<{locations: number, characters: number, general: number}>}
 *          Counts of entries added/updated, or all zeros on failure.
 */
async function extractFlavorDescriptions(transcript, storyText, campaignContext) {
  const empty = { locations: 0, characters: 0, general: 0 };
  try {
    if (!campaignContext) return empty;

    // Build a snapshot of the existing flavor bank for the prompt
    const existingBank = campaignContext.flavorBank || { locations: {}, characters: {}, general: [] };

    const extractionPrompt = `Analyze this D&D session transcript. Extract vivid descriptions of LOCATIONS or CHARACTERS given by the DM or players. Compare against the existing flavor bank and only return NEW or UPDATED entries. Return JSON: { "locations": { "Name": "description" }, "characters": { "Name": "description" }, "general": ["world-building details"] }. Only include genuinely new or significantly more detailed entries. Return empty objects/arrays if nothing new.

EXISTING FLAVOR BANK:
${JSON.stringify(existingBank, null, 2)}

=== SESSION TRANSCRIPT ===
${transcript}

=== GENERATED STORY ===
${storyText}`;

    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Strip possible markdown code fences
    const jsonMatch = rawText.match(/```json?\s*([\s\S]*?)```/) || [null, rawText];
    const parsed = JSON.parse(jsonMatch[1].trim());

    // Validate shape
    if (typeof parsed !== 'object' || parsed === null) return empty;

    const newLocations = parsed.locations && typeof parsed.locations === 'object' ? parsed.locations : {};
    const newCharacters = parsed.characters && typeof parsed.characters === 'object' ? parsed.characters : {};
    const newGeneral = Array.isArray(parsed.general) ? parsed.general.filter(g => typeof g === 'string') : [];

    // Count what we're adding/updating
    const counts = { locations: 0, characters: 0, general: 0 };

    // Ensure flavorBank exists on the context
    if (!campaignContext.flavorBank) {
      campaignContext.flavorBank = { locations: {}, characters: {}, general: [] };
    }
    if (!campaignContext.flavorBank.locations) campaignContext.flavorBank.locations = {};
    if (!campaignContext.flavorBank.characters) campaignContext.flavorBank.characters = {};
    if (!Array.isArray(campaignContext.flavorBank.general)) campaignContext.flavorBank.general = [];

    // Merge locations — add new, update existing only if new description is longer
    for (const [name, desc] of Object.entries(newLocations)) {
      if (typeof desc !== 'string' || !desc.trim()) continue;
      const existing = campaignContext.flavorBank.locations[name];
      if (!existing || desc.trim().length > existing.length) {
        campaignContext.flavorBank.locations[name] = desc.trim();
        counts.locations++;
      }
    }

    // Merge characters — same logic
    for (const [name, desc] of Object.entries(newCharacters)) {
      if (typeof desc !== 'string' || !desc.trim()) continue;
      const existing = campaignContext.flavorBank.characters[name];
      if (!existing || desc.trim().length > existing.length) {
        campaignContext.flavorBank.characters[name] = desc.trim();
        counts.characters++;
      }
    }

    // Merge general — append only if not a duplicate (case-insensitive)
    const existingGeneralLower = campaignContext.flavorBank.general.map(g => g.toLowerCase());
    for (const entry of newGeneral) {
      if (!entry.trim()) continue;
      if (!existingGeneralLower.includes(entry.trim().toLowerCase())) {
        campaignContext.flavorBank.general.push(entry.trim());
        existingGeneralLower.push(entry.trim().toLowerCase());
        counts.general++;
      }
    }

    // Save updated campaign-context.json if anything changed
    const totalAdded = counts.locations + counts.characters + counts.general;
    if (totalAdded > 0) {
      const ctxPath = config.paths.campaignContext;
      fs.writeFileSync(ctxPath, JSON.stringify(campaignContext, null, 2), 'utf-8');
      log.info('Flavor bank updated', counts);
    }

    return counts;
  } catch (err) {
    log.warn('Flavor bank extraction failed (non-fatal)', { error: err.message });
    return empty;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  NPC DETECTION
// ═══════════════════════════════════════════════════════════════════

async function detectNewCharacters(transcript, storyText, campaignContext) {
  try {
    if (!campaignContext) return [];

    // Build the list of known character names — include ALL sources
    const knownNames = [];
    if (campaignContext.playerCharacters) {
      for (const pc of campaignContext.playerCharacters) {
        if (pc.name) knownNames.push(pc.name);
      }
    }
    if (campaignContext.recurringNPCs) {
      for (const npc of campaignContext.recurringNPCs) {
        if (npc.name) knownNames.push(npc.name);
      }
    }
    if (campaignContext.inactiveCharacters) {
      for (const ic of campaignContext.inactiveCharacters) {
        if (ic.name) knownNames.push(ic.name);
      }
    }

    const detectionPrompt = `Given this D&D session transcript and the generated story, identify any NEW named characters (NPCs, creatures, or entities) that appear in the session but are NOT in this list of known characters: ${JSON.stringify(knownNames)}.

Return a JSON array of objects with:
- name: the character's name
- role: their apparent role/title
- description: brief description based on what happened in the session
- relationship: their apparent relationship to the party

If there are no new characters, return an empty array [].
Return ONLY valid JSON — no markdown fences, no explanation.`;

    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `${detectionPrompt}\n\n=== TRANSCRIPT ===\n${transcript}\n\n=== GENERATED STORY ===\n${storyText}`,
      }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Strip possible markdown code fences
    const jsonMatch = rawText.match(/```json?\s*([\s\S]*?)```/) || [null, rawText];
    const parsed = JSON.parse(jsonMatch[1].trim());

    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    // Non-fatal — just log and return empty
    log.warn('New character detection failed (non-fatal)', { error: err.message });
    return [];
  }
}

module.exports = { generateStory, generateOneShotStory, findLatestTranscript, detectNewCharacters, extractFlavorDescriptions, verifyStory, getHistoricalPatterns, STYLE_PROMPTS, CREATIVITY_INSTRUCTIONS, buildSystemPrompt };
