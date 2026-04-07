/**
 * Discord utility functions — shared embed builders and text helpers.
 */

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const config = require('../config');

// ─── Style colors for embeds ────────────────────────────────────────

const STYLE_COLORS = {
  martin: 0x2d1b69,     // dark fantasy purple
  sanderson: 0x1b3d69,  // cosmere blue
};

// ─── Embed builder ──────────────────────────────────────────────────

function makeEmbed(title, description, success = true) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(success ? 0x57f287 : 0xed4245)
    .setTimestamp()
    .setFooter({ text: 'D&D Scribe Bot' });
}

// ─── Recap channel finder ───────────────────────────────────────────

/**
 * Find the recap channel in a guild by partial name match (case-insensitive).
 * Falls back to the provided fallback channel if none found.
 */
function findRecapChannel(guild, fallbackChannel) {
  const targetName = config.recap.channelName.toLowerCase();
  const recapChannel = guild.channels.cache.find(
    ch => ch.isTextBased() && ch.name.toLowerCase().includes(targetName)
  );
  return recapChannel || fallbackChannel;
}

// ─── Story text helpers ─────────────────────────────────────────────

/**
 * Extract a title from the story's first line (expects "# Title" markdown).
 * Returns { title, body } where body has the title line stripped.
 */
function extractStoryTitle(storyContent) {
  const lines = storyContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('# ')) {
      const title = line.replace(/^#+\s*/, '');
      const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim();
      return { title, body };
    }
    // Skip blank lines at the top
    if (line !== '') break;
  }
  return { title: null, body: storyContent };
}

/**
 * Bold the first paragraph of the story for dramatic effect.
 */
function boldFirstParagraph(text) {
  const trimmed = text.trim();
  const doubleNewline = trimmed.indexOf('\n\n');
  if (doubleNewline === -1) return `**${trimmed}**`;
  const firstPara = trimmed.slice(0, doubleNewline).trim();
  const rest = trimmed.slice(doubleNewline);
  return `**${firstPara}**${rest}`;
}

/**
 * Split text into chunks that fit within Discord's embed description limit (4096 chars).
 * Splits at paragraph boundaries when possible.
 */
function splitForEmbeds(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Paragraph boundary is too early; try a single newline
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // Last resort: split at a space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ─── Campaign context loader ────────────────────────────────────────

/**
 * Load campaign context to extract PC names for the summary embed.
 */
function loadCampaignContextForRecap() {
  try {
    const ctxPath = config.paths.campaignContext;
    if (!fs.existsSync(ctxPath)) return null;
    return JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
  } catch { return null; }
}

// ─── Command Dictionary Embed ───────────────────────────────────────

/**
 * Build the command reference embed used by !help and on voice join.
 */
function buildCommandEmbed() {
  return new EmbedBuilder()
    .setTitle('D&D Scribe Bot \u2014 Commands')
    .setColor(0xFFB800)
    .addFields(
      {
        name: 'Recording',
        value: [
          '`!record` / `/record` \u2014 Start recording the session',
          '`!record-one-shot` / `/record-one-shot` \u2014 Start a one-shot recording (higher accuracy, doesn\'t affect campaign log)',
          '`!stop` / `/stop` \u2014 Stop recording and auto-process',
        ].join('\n'),
        inline: false,
      },
      {
        name: 'During Session',
        value: '`!switchchar [name]` / `/switchchar` \u2014 Switch your active character mid-session',
        inline: false,
      },
      {
        name: 'After Session',
        value: [
          '`!recap` / `/recap` \u2014 Re-post the latest story chapter',
          '`!speakers` / `/speakers` \u2014 Map or view speaker-to-character assignments',
          '`!addnpc Name | Role | Description | Relationship` \u2014 Add a new NPC to campaign context',
          '`!listnpcs` / `/listnpcs` \u2014 List all known NPCs by relationship',
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Utility',
        value: '`!help` \u2014 Show this command list again',
        inline: false,
      },
    )
    .setFooter({ text: 'Stories auto-post to #recap after processing' })
    .setTimestamp();
}

/**
 * Post the command dictionary embed to a channel.
 */
async function postCommandDictionary(channel) {
  try {
    await channel.send({ embeds: [buildCommandEmbed()] });
  } catch (err) {
    const log = require('../logger');
    log.warn('Failed to post command dictionary', { error: err.message });
  }
}

/**
 * Format a duration in milliseconds to HH:MM:SS.
 */
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(1, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m.padStart(2, '0')}:${s}`;
}

module.exports = {
  STYLE_COLORS,
  makeEmbed,
  findRecapChannel,
  extractStoryTitle,
  boldFirstParagraph,
  splitForEmbeds,
  loadCampaignContextForRecap,
  buildCommandEmbed,
  postCommandDictionary,
  formatDuration,
};
