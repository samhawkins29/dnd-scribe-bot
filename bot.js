#!/usr/bin/env node
/**
 * D&D Scribe Bot — Discord voice recorder
 *
 * Joins a voice channel, mixes all participant audio into a single file,
 * and saves it for later transcription and story generation.
 *
 * Supports both prefix commands (!record / !stop) and slash commands
 * (/record / /stop).
 *
 * This file is the entry point — run with `node bot.js`.
 * All logic lives in the modules/ directory.
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActivityType,
} = require('discord.js');
const fs = require('fs');
const config = require('./config');
const log = require('./logger');

// ─── Modules ────────────────────────────────────────────────────────
const { sessions, stopRecording } = require('./modules/recorder');
const { slashCommands, registerPrefixCommands, registerSlashCommands } = require('./modules/commands');

// ─── Ensure output directories exist ────────────────────────────────
for (const dir of Object.values(config.paths)) {
  if (!dir.endsWith('.json') && !dir.endsWith('.md')) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Discord client ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Register event handlers ────────────────────────────────────────
registerPrefixCommands(client);
registerSlashCommands(client);

// ─── Register slash commands on ready ───────────────────────────────
client.once('ready', async () => {
  log.info(`Logged in as ${client.user.tag}`);
  client.user.setActivity('your D&D session', { type: ActivityType.Listening });

  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    const route = config.discord.guildId
      ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
      : Routes.applicationCommands(config.discord.clientId);

    await rest.put(route, { body: slashCommands.map(c => c.toJSON()) });
    log.info('Slash commands registered');
  } catch (err) {
    log.error('Failed to register slash commands', { error: err.message });
  }
});

// ─── Graceful shutdown ──────────────────────────────────────────────

async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  for (const [guildId] of sessions) {
    await stopRecording(guildId);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Global safety nets — keep the bot alive on stray errors ───────
// Discord occasionally sends corrupted Opus packets or triggers edge-case
// errors in stream internals. These handlers prevent the process from
// crashing during a multi-hour recording session.

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception (process kept alive)', {
    error: err.message,
    stack: err.stack,
  });
  // Don't exit — keep recording
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection (process kept alive)', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// ─── Start ──────────────────────────────────────────────────────────

client.login(config.discord.token).catch(err => {
  log.error('Failed to login to Discord', { error: err.message });
  console.error('\nMake sure your DISCORD_BOT_TOKEN is set in .env or config.js');
  process.exit(1);
});
