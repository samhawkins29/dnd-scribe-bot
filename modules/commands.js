/**
 * Command handlers — prefix commands (!record, !stop, etc.) and slash commands.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');
const { sessions, startRecording, stopRecording, handleSwitchChar, findLatestSpeakersFile } = require('./recorder');
const { runPipelineWithUpdates, runOneShotPipelineWithUpdates, repostLatestRecap } = require('./pipeline');
const { makeEmbed, buildCommandEmbed } = require('./discord-utils');

// ─── Slash command definitions ──────────────────────────────────────

const slashCommands = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Start recording the current voice channel for D&D session transcription.'),
  new SlashCommandBuilder()
    .setName('record-one-shot')
    .setDescription('Start a one-shot recording (higher accuracy, doesn\'t affect campaign log).'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop recording and save the session audio.'),
  new SlashCommandBuilder()
    .setName('recap')
    .setDescription('Re-post the latest story chapter to this channel.'),
  new SlashCommandBuilder()
    .setName('switchchar')
    .setDescription('Switch your active character mid-session.')
    .addStringOption(opt => opt.setName('character').setDescription('New character name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('addnpc')
    .setDescription('Add a new NPC to the campaign context.')
    .addStringOption(opt => opt.setName('name').setDescription('NPC name').setRequired(true))
    .addStringOption(opt => opt.setName('role').setDescription('NPC role or title').setRequired(true))
    .addStringOption(opt => opt.setName('description').setDescription('Brief description').setRequired(false))
    .addStringOption(opt => opt.setName('relationship').setDescription('Relationship to the party').setRequired(false)),
  new SlashCommandBuilder()
    .setName('listnpcs')
    .setDescription('List all known NPCs grouped by relationship.'),
  new SlashCommandBuilder()
    .setName('speakers')
    .setDescription('Map Discord users to D&D character names for transcript labelling.')
    .addStringOption(opt => opt.setName('mappings').setDescription('Space-separated mappings: DisplayName=CharacterName').setRequired(false)),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available bot commands.'),
];

// ─── Prefix command handler ─────────────────────────────────────────

/**
 * Register prefix command handler on a Discord client.
 * @param {Client} client - The Discord.js client
 */
function registerPrefixCommands(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content.trim().toLowerCase();

    if (content === '!record') {
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        return message.reply({ embeds: [makeEmbed('Error', 'You must be in a voice channel first!', false)] });
      }
      const result = await startRecording(message.guildId, voiceChannel, message.channel, 'standard', client.user.id);
      return message.reply({ embeds: [makeEmbed(
        result.success ? 'Recording Started' : 'Error',
        result.message,
        result.success
      )] });
    }

    if (content === '!record-one-shot') {
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        return message.reply({ embeds: [makeEmbed('Error', 'You must be in a voice channel first!', false)] });
      }
      const result = await startRecording(message.guildId, voiceChannel, message.channel, 'oneshot', client.user.id);
      return message.reply({ embeds: [makeEmbed(
        result.success ? 'One-Shot Recording Started' : 'Error',
        result.message,
        result.success
      )] });
    }

    if (content === '!stop') {
      const session = sessions.get(message.guildId);
      const sessionDurationMs = session?.startTime ? Date.now() - session.startTime : 0;
      const sessionMode = session?.mode || 'standard';
      const result = await stopRecording(message.guildId);
      await message.reply({ embeds: [makeEmbed(
        result.success ? 'Recording Saved' : 'Error',
        result.message,
        result.success
      )] });
      // Fire-and-forget: run the appropriate pipeline in the background
      if (result.success && result.audioPath) {
        if (sessionMode === 'oneshot') {
          runOneShotPipelineWithUpdates(message.channel, result.audioPath, sessionDurationMs);
        } else {
          runPipelineWithUpdates(message.channel, result.audioPath, sessionDurationMs);
        }
      }
      return;
    }

    // ── !switchchar CharacterName ─────────────────────────────────────
    if (message.content.trim().toLowerCase().startsWith('!switchchar ')) {
      const newCharacter = message.content.trim().slice('!switchchar '.length).trim();
      const displayName = message.member?.displayName || message.author.username;
      const result = handleSwitchChar(message.guildId, message.author.id, displayName, newCharacter);
      return message.reply({ embeds: [makeEmbed(
        result.success ? 'Character Switched' : 'Error',
        result.message,
        result.success
      )] });
    }

    if (content === '!help') {
      return message.reply({ embeds: [buildCommandEmbed()] });
    }

    if (content === '!recap') {
      await repostLatestRecap(message.channel);
      return;
    }

    // ── !addnpc Name | Role | Description | Relationship ────────────
    if (message.content.trim().toLowerCase().startsWith('!addnpc ')) {
      const raw = message.content.trim().slice('!addnpc '.length);
      const parts = raw.split('|').map(s => s.trim());

      if (parts.length < 2) {
        return message.reply({
          embeds: [makeEmbed('Usage', '`!addnpc Name | Role | Description | Relationship`\nAt minimum provide Name and Role.', false)],
        });
      }

      const [name, role, description, relationship] = parts;

      try {
        const ctxPath = config.paths.campaignContext;
        const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
        if (!ctx.recurringNPCs) ctx.recurringNPCs = [];

        ctx.recurringNPCs.push({
          name,
          role: role || 'Unknown',
          description: description || '',
          relationship: relationship || 'Unknown',
        });

        fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), 'utf-8');
        log.info('NPC added via !addnpc', { name });

        return message.reply({
          embeds: [makeEmbed('NPC Added', `Added **${name}** to campaign context!`, true)],
        });
      } catch (err) {
        log.error('Failed to add NPC', { error: err.message });
        return message.reply({
          embeds: [makeEmbed('Error', `Failed to add NPC: ${err.message}`, false)],
        });
      }
    }

    // ── !speakers ────────────────────────────────────────────────────
    if (message.content.trim().toLowerCase().startsWith('!speakers')) {
      const raw = message.content.trim().slice('!speakers'.length).trim();
      const speakerMapPath = path.join(config.paths.lore, 'speaker-map.json');

      // Load existing map
      let speakerMap = { users: {} };
      if (fs.existsSync(speakerMapPath)) {
        try { speakerMap = JSON.parse(fs.readFileSync(speakerMapPath, 'utf-8')); } catch { /* ignore */ }
      }

      if (!raw) {
        // No arguments: show current mappings and prompt from last session
        const latestSpeakersFile = findLatestSpeakersFile();
        let hint = '';
        if (latestSpeakersFile) {
          try {
            const data = JSON.parse(fs.readFileSync(latestSpeakersFile, 'utf-8'));
            const unmapped = Object.entries(data.users || {}).filter(([uid]) => !speakerMap.users[uid]);
            if (unmapped.length > 0) {
              hint = `\n\n**Unmapped speakers from last session:**\n${unmapped.map(([uid, name]) => `• ${name} (ID: ${uid})`).join('\n')}\n\nUse \`!speakers ${unmapped.map(([, name]) => `${name}=CharacterName`).join(' ')}\` to map them.`;
            } else {
              hint = '\n\nAll speakers from the last session are already mapped!';
            }
          } catch { /* ignore */ }
        }

        const current = Object.entries(speakerMap.users);
        const mappingList = current.length > 0
          ? current.map(([uid, info]) => `• **${info.displayName || uid}** → ${info.characterName}`).join('\n')
          : 'No mappings yet.';

        return message.reply({
          embeds: [makeEmbed('Speaker Mappings', `${mappingList}${hint}`, true)],
        });
      }

      // Parse mappings: supports "DisplayName=CharacterName" or "userId=DisplayName(CharacterName)"
      const pairs = raw.split(/\s+/);
      const latestSpeakersFile = findLatestSpeakersFile();
      let sessionUsers = {};
      if (latestSpeakersFile) {
        try {
          const data = JSON.parse(fs.readFileSync(latestSpeakersFile, 'utf-8'));
          sessionUsers = data.users || {};
        } catch { /* ignore */ }
      }

      let mapped = 0;
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) continue;

        const left = pair.slice(0, eqIdx).trim();
        const right = pair.slice(eqIdx + 1).trim();

        // Check if left is a Discord user ID (all digits)
        if (/^\d+$/.test(left)) {
          // Format: userId=DisplayName(CharacterName) or userId=CharacterName
          const charMatch = right.match(/^(.+?)\((.+?)\)$/) || [null, right, right];
          speakerMap.users[left] = {
            displayName: charMatch[1],
            characterName: charMatch[2],
          };
          mapped++;
        } else {
          // Format: DisplayName=CharacterName — look up ID from session data
          const matchedEntry = Object.entries(sessionUsers).find(
            ([, displayName]) => displayName.toLowerCase() === left.toLowerCase()
          );
          if (matchedEntry) {
            speakerMap.users[matchedEntry[0]] = {
              displayName: matchedEntry[1],
              characterName: right,
            };
            mapped++;
          } else {
            // Try matching from guild members as fallback
            const member = message.guild.members.cache.find(
              m => m.displayName.toLowerCase() === left.toLowerCase() ||
                   m.user.username.toLowerCase() === left.toLowerCase()
            );
            if (member) {
              speakerMap.users[member.id] = {
                displayName: member.displayName,
                characterName: right,
              };
              mapped++;
            }
          }
        }
      }

      fs.writeFileSync(speakerMapPath, JSON.stringify(speakerMap, null, 2), 'utf-8');
      log.info('Speaker map updated via !speakers', { mapped, total: Object.keys(speakerMap.users).length });

      return message.reply({
        embeds: [makeEmbed('Speakers Updated', `Mapped **${mapped}** speaker(s). Total mappings: ${Object.keys(speakerMap.users).length}`, true)],
      });
    }

    // ── !listnpcs ────────────────────────────────────────────────────
    if (content === '!listnpcs') {
      try {
        const ctx = JSON.parse(fs.readFileSync(config.paths.campaignContext, 'utf-8'));
        const npcs = ctx.recurringNPCs || [];

        if (npcs.length === 0) {
          return message.reply({
            embeds: [makeEmbed('Known NPCs', 'No recurring NPCs in campaign context yet.', true)],
          });
        }

        // Group by relationship keyword
        const groups = { Friendly: [], Hostile: [], Indifferent: [], Unknown: [] };
        for (const npc of npcs) {
          const rel = (npc.relationship || '').toLowerCase();
          if (rel.startsWith('friendly')) groups.Friendly.push(npc);
          else if (rel.startsWith('hostile')) groups.Hostile.push(npc);
          else if (rel.startsWith('indifferent')) groups.Indifferent.push(npc);
          else groups.Unknown.push(npc);
        }

        const fields = [];
        for (const [label, list] of Object.entries(groups)) {
          if (list.length === 0) continue;
          const value = list.map(n => `**${n.name}** — *${n.role || 'Unknown'}*`).join('\n');
          fields.push({ name: `${label} (${list.length})`, value, inline: false });
        }

        const embed = new EmbedBuilder()
          .setTitle('Known NPCs')
          .setColor(0xFFB800)
          .addFields(fields)
          .setFooter({ text: `${npcs.length} total NPCs` })
          .setTimestamp();

        return message.reply({ embeds: [embed] });
      } catch (err) {
        log.error('Failed to list NPCs', { error: err.message });
        return message.reply({
          embeds: [makeEmbed('Error', `Failed to list NPCs: ${err.message}`, false)],
        });
      }
    }
  });
}

// ─── Slash command interaction handler ──────────────────────────────

/**
 * Register slash command interaction handler on a Discord client.
 * @param {Client} client - The Discord.js client
 */
function registerSlashCommands(client) {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'record') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({
          embeds: [makeEmbed('Error', 'You must be in a voice channel first!', false)],
          ephemeral: true,
        });
      }
      await interaction.deferReply();
      const result = await startRecording(interaction.guildId, voiceChannel, interaction.channel, 'standard', client.user.id);
      return interaction.editReply({ embeds: [makeEmbed(
        result.success ? 'Recording Started' : 'Error',
        result.message,
        result.success
      )] });
    }

    if (interaction.commandName === 'record-one-shot') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({
          embeds: [makeEmbed('Error', 'You must be in a voice channel first!', false)],
          ephemeral: true,
        });
      }
      await interaction.deferReply();
      const result = await startRecording(interaction.guildId, voiceChannel, interaction.channel, 'oneshot', client.user.id);
      return interaction.editReply({ embeds: [makeEmbed(
        result.success ? 'One-Shot Recording Started' : 'Error',
        result.message,
        result.success
      )] });
    }

    if (interaction.commandName === 'stop') {
      const session = sessions.get(interaction.guildId);
      const sessionDurationMs = session?.startTime ? Date.now() - session.startTime : 0;
      const sessionMode = session?.mode || 'standard';
      await interaction.deferReply();
      const result = await stopRecording(interaction.guildId);
      await interaction.editReply({ embeds: [makeEmbed(
        result.success ? 'Recording Saved' : 'Error',
        result.message,
        result.success
      )] });
      // Fire-and-forget: run the appropriate pipeline in the background
      if (result.success && result.audioPath) {
        if (sessionMode === 'oneshot') {
          runOneShotPipelineWithUpdates(interaction.channel, result.audioPath, sessionDurationMs);
        } else {
          runPipelineWithUpdates(interaction.channel, result.audioPath, sessionDurationMs);
        }
      }
      return;
    }

    // ── /switchchar ────────────────────────────────────────────────────
    if (interaction.commandName === 'switchchar') {
      const newCharacter = interaction.options.getString('character');
      const displayName = interaction.member?.displayName || interaction.user.username;
      const result = handleSwitchChar(interaction.guildId, interaction.user.id, displayName, newCharacter);
      return interaction.reply({ embeds: [makeEmbed(
        result.success ? 'Character Switched' : 'Error',
        result.message,
        result.success
      )] });
    }

    // ── /help ──────────────────────────────────────────────────────────
    if (interaction.commandName === 'help') {
      return interaction.reply({ embeds: [buildCommandEmbed()] });
    }

    if (interaction.commandName === 'recap') {
      await interaction.deferReply();
      await repostLatestRecap(interaction.channel);
      await interaction.editReply({ embeds: [makeEmbed('Recap', 'Latest story re-posted above!', true)] });
      return;
    }

    // ── /addnpc ──────────────────────────────────────────────────────
    if (interaction.commandName === 'addnpc') {
      const name = interaction.options.getString('name');
      const role = interaction.options.getString('role');
      const description = interaction.options.getString('description') || '';
      const relationship = interaction.options.getString('relationship') || 'Unknown';

      try {
        const ctxPath = config.paths.campaignContext;
        const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
        if (!ctx.recurringNPCs) ctx.recurringNPCs = [];

        ctx.recurringNPCs.push({ name, role, description, relationship });
        fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), 'utf-8');
        log.info('NPC added via /addnpc', { name });

        return interaction.reply({
          embeds: [makeEmbed('NPC Added', `Added **${name}** to campaign context!`, true)],
        });
      } catch (err) {
        log.error('Failed to add NPC via slash command', { error: err.message });
        return interaction.reply({
          embeds: [makeEmbed('Error', `Failed to add NPC: ${err.message}`, false)],
          ephemeral: true,
        });
      }
    }

    // ── /listnpcs ────────────────────────────────────────────────────
    if (interaction.commandName === 'listnpcs') {
      try {
        const ctx = JSON.parse(fs.readFileSync(config.paths.campaignContext, 'utf-8'));
        const npcs = ctx.recurringNPCs || [];

        if (npcs.length === 0) {
          return interaction.reply({
            embeds: [makeEmbed('Known NPCs', 'No recurring NPCs in campaign context yet.', true)],
          });
        }

        const groups = { Friendly: [], Hostile: [], Indifferent: [], Unknown: [] };
        for (const npc of npcs) {
          const rel = (npc.relationship || '').toLowerCase();
          if (rel.startsWith('friendly')) groups.Friendly.push(npc);
          else if (rel.startsWith('hostile')) groups.Hostile.push(npc);
          else if (rel.startsWith('indifferent')) groups.Indifferent.push(npc);
          else groups.Unknown.push(npc);
        }

        const fields = [];
        for (const [label, list] of Object.entries(groups)) {
          if (list.length === 0) continue;
          const value = list.map(n => `**${n.name}** — *${n.role || 'Unknown'}*`).join('\n');
          fields.push({ name: `${label} (${list.length})`, value, inline: false });
        }

        const embed = new EmbedBuilder()
          .setTitle('Known NPCs')
          .setColor(0xFFB800)
          .addFields(fields)
          .setFooter({ text: `${npcs.length} total NPCs` })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        log.error('Failed to list NPCs via slash command', { error: err.message });
        return interaction.reply({
          embeds: [makeEmbed('Error', `Failed to list NPCs: ${err.message}`, false)],
          ephemeral: true,
        });
      }
    }

    // ── /speakers ──────────────────────────────────────────────────
    if (interaction.commandName === 'speakers') {
      const raw = interaction.options.getString('mappings') || '';
      const speakerMapPath = path.join(config.paths.lore, 'speaker-map.json');

      let speakerMap = { users: {} };
      if (fs.existsSync(speakerMapPath)) {
        try { speakerMap = JSON.parse(fs.readFileSync(speakerMapPath, 'utf-8')); } catch { /* ignore */ }
      }

      if (!raw) {
        // Show current mappings
        const latestSpeakersFile = findLatestSpeakersFile();
        let hint = '';
        if (latestSpeakersFile) {
          try {
            const data = JSON.parse(fs.readFileSync(latestSpeakersFile, 'utf-8'));
            const unmapped = Object.entries(data.users || {}).filter(([uid]) => !speakerMap.users[uid]);
            if (unmapped.length > 0) {
              hint = `\n\n**Unmapped speakers from last session:**\n${unmapped.map(([uid, name]) => `• ${name} (ID: ${uid})`).join('\n')}\n\nUse \`/speakers mappings:${unmapped.map(([, name]) => `${name}=CharacterName`).join(' ')}\` to map them.`;
            } else {
              hint = '\n\nAll speakers from the last session are already mapped!';
            }
          } catch { /* ignore */ }
        }

        const current = Object.entries(speakerMap.users);
        const mappingList = current.length > 0
          ? current.map(([uid, info]) => `• **${info.displayName || uid}** → ${info.characterName}`).join('\n')
          : 'No mappings yet.';

        return interaction.reply({
          embeds: [makeEmbed('Speaker Mappings', `${mappingList}${hint}`, true)],
        });
      }

      // Parse mappings
      const pairs = raw.split(/\s+/);
      const latestSpeakersFile = findLatestSpeakersFile();
      let sessionUsers = {};
      if (latestSpeakersFile) {
        try {
          const data = JSON.parse(fs.readFileSync(latestSpeakersFile, 'utf-8'));
          sessionUsers = data.users || {};
        } catch { /* ignore */ }
      }

      let mapped = 0;
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) continue;

        const left = pair.slice(0, eqIdx).trim();
        const right = pair.slice(eqIdx + 1).trim();

        if (/^\d+$/.test(left)) {
          const charMatch = right.match(/^(.+?)\((.+?)\)$/) || [null, right, right];
          speakerMap.users[left] = { displayName: charMatch[1], characterName: charMatch[2] };
          mapped++;
        } else {
          const matchedEntry = Object.entries(sessionUsers).find(
            ([, displayName]) => displayName.toLowerCase() === left.toLowerCase()
          );
          if (matchedEntry) {
            speakerMap.users[matchedEntry[0]] = { displayName: matchedEntry[1], characterName: right };
            mapped++;
          } else {
            const member = interaction.guild.members.cache.find(
              m => m.displayName.toLowerCase() === left.toLowerCase() ||
                   m.user.username.toLowerCase() === left.toLowerCase()
            );
            if (member) {
              speakerMap.users[member.id] = { displayName: member.displayName, characterName: right };
              mapped++;
            }
          }
        }
      }

      fs.writeFileSync(speakerMapPath, JSON.stringify(speakerMap, null, 2), 'utf-8');
      log.info('Speaker map updated via /speakers', { mapped, total: Object.keys(speakerMap.users).length });

      return interaction.reply({
        embeds: [makeEmbed('Speakers Updated', `Mapped **${mapped}** speaker(s). Total mappings: ${Object.keys(speakerMap.users).length}`, true)],
      });
    }
  });
}

module.exports = {
  slashCommands,
  registerPrefixCommands,
  registerSlashCommands,
};
