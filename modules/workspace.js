/**
 * D&D Scribe Bot — Per-guild workspace resolution.
 *
 * All campaign state used to live in single global files (lore/campaign-context.json,
 * lore/speaker-map.json, stories/campaign-log.md, stories/sessions.json, the chapter
 * counter, and stories/verification-history.json). Two Discord servers running the
 * same bot would clobber each other's context and interleave each other's chapters.
 *
 * resolveWorkspace(guildId) returns a namespaced set of paths so each guild gets its
 * own state. To keep existing single-campaign installs working untouched, the
 * "primary" guild (and any unknown/legacy caller) maps to the original flat layout;
 * every other guild is namespaced under lore/guilds/<id>/ and stories/guilds/<id>/.
 *
 * Set PRIMARY_GUILD_ID in the environment to the main server's id to keep that
 * server's data in the legacy location. Leave it empty and the first/only server's
 * data simply stays where it is via the 'default' legacy workspace.
 */

const path = require('path');
const config = require('../config');

// The server whose data stays in the legacy flat layout (lore/*.json, stories/*).
const PRIMARY_GUILD_ID = process.env.PRIMARY_GUILD_ID || '';

/** A caller without a real guild id, or the configured primary guild, uses legacy paths. */
function isLegacy(guildId) {
  if (!guildId) return true;
  if (guildId === 'unknown' || guildId === 'default') return true;
  if (PRIMARY_GUILD_ID && guildId === PRIMARY_GUILD_ID) return true;
  return false;
}

/**
 * Sanitize a guild id into a safe single path segment. Discord snowflakes are all
 * digits, but we defend against path traversal / separators regardless.
 */
function safeGuildSegment(guildId) {
  const cleaned = String(guildId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'unknown';
}

/**
 * Resolve all guild-scoped state paths.
 *
 * @param {string} [guildId]
 * @returns {{
 *   guildId: string, legacy: boolean, lore: string, stories: string,
 *   campaignContext: string, oneshotContext: string, campaignLog: string,
 *   sessionsLog: string, speakerMap: string, verificationHistory: string,
 * }}
 */
function resolveWorkspace(guildId) {
  if (isLegacy(guildId)) {
    return {
      guildId: guildId || 'default',
      legacy: true,
      lore: config.paths.lore,
      stories: config.paths.stories,
      campaignContext: config.paths.campaignContext,
      oneshotContext: config.paths.oneshotContext,
      campaignLog: config.paths.campaignLog,
      sessionsLog: config.paths.sessionsLog,
      speakerMap: path.join(config.paths.lore, 'speaker-map.json'),
      verificationHistory: path.join(config.paths.stories, 'verification-history.json'),
    };
  }

  const seg = safeGuildSegment(guildId);
  const lore = path.join(config.paths.lore, 'guilds', seg);
  const stories = path.join(config.paths.stories, 'guilds', seg);
  return {
    guildId: seg,
    legacy: false,
    lore,
    stories,
    campaignContext: path.join(lore, 'campaign-context.json'),
    oneshotContext: path.join(lore, 'oneshot-context.json'),
    campaignLog: path.join(stories, 'campaign-log.md'),
    sessionsLog: path.join(stories, 'sessions.json'),
    speakerMap: path.join(lore, 'speaker-map.json'),
    verificationHistory: path.join(stories, 'verification-history.json'),
  };
}

module.exports = { resolveWorkspace, safeGuildSegment, isLegacy, PRIMARY_GUILD_ID };
