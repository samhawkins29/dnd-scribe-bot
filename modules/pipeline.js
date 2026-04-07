/**
 * Pipeline module — transcription + story generation + Discord posting.
 */

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');
const { transcribe } = require('../transcribe');
const { generateStory, generateOneShotStory, detectNewCharacters, extractFlavorDescriptions } = require('../generate-story');
const {
  makeEmbed,
  findRecapChannel,
  extractStoryTitle,
  boldFirstParagraph,
  splitForEmbeds,
  loadCampaignContextForRecap,
  STYLE_COLORS,
} = require('./discord-utils');

// ─── Auto-pipeline with Discord progress updates ───────────────────

/**
 * Run the transcription + story generation pipeline in the background,
 * posting progress messages to the Discord text channel.
 * This is fire-and-forget — it does NOT block the bot event loop.
 */
async function runPipelineWithUpdates(textChannel, audioPath, sessionDurationMs = 0) {
  const style = config.story.defaultStyle;

  try {
    // Step 1: Transcribe
    const transcribeMsg = await textChannel.send({
      embeds: [makeEmbed('Transcribing audio...', 'Converting your session audio to text. This may take a moment.', true)],
    });

    const transcriptPath = await transcribe(audioPath, { service: undefined });
    log.info('Transcription complete', { transcriptPath });

    // Step 2: Generate story
    await transcribeMsg.edit({
      embeds: [makeEmbed('Generating story...', `Crafting your session narrative in **${style}** style.`, true)],
    });

    const { storyPath, chapterNum, verificationResult } = await generateStory(transcriptPath, { style });
    log.info('Story generation complete', { storyPath, chapterNum });

    // Step 3: Post the story to the recap channel
    await transcribeMsg.edit({
      embeds: [makeEmbed('Posting story...', `Chapter ${chapterNum} generated! Posting to recap channel now.`, true)],
    });

    await postRecapToDiscord(textChannel, storyPath, chapterNum, style, sessionDurationMs, verificationResult);

    // Update the progress message
    await transcribeMsg.edit({
      embeds: [makeEmbed(
        'Pipeline complete!',
        `Chapter ${chapterNum} has been generated and posted.`,
        true,
      )],
    });

    // ── Fire-and-forget: detect new characters after story is posted ──
    (async () => {
      try {
        const transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
        const storyText = fs.readFileSync(storyPath, 'utf-8');
        const campaignCtx = loadCampaignContextForRecap();

        const newChars = await detectNewCharacters(transcriptText, storyText, campaignCtx);
        if (newChars.length > 0) {
          const guild = textChannel.guild;
          const recapChannel = findRecapChannel(guild, textChannel);

          const charList = newChars.map(c =>
            `**${c.name}** — *${c.role || 'Unknown role'}*\n${c.description || 'No description.'}`
          ).join('\n\n');

          const npcEmbed = new EmbedBuilder()
            .setTitle('New Characters Detected')
            .setColor(0xFFB800)
            .setDescription(charList)
            .setFooter({ text: 'Add these to your campaign context with !addnpc or edit lore/campaign-context.json' })
            .setTimestamp();

          await recapChannel.send({ embeds: [npcEmbed] });
          log.info('New character detection posted', { count: newChars.length });
        }
      } catch (err) {
        // Silent failure — don't break the flow
        log.warn('New character detection skipped', { error: err.message });
      }
    })();

    // ── Fire-and-forget: extract flavor descriptions for the flavor bank ──
    (async () => {
      try {
        const transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
        const storyText = fs.readFileSync(storyPath, 'utf-8');
        const campaignCtx = loadCampaignContextForRecap();

        const counts = await extractFlavorDescriptions(transcriptText, storyText, campaignCtx);
        const totalAdded = counts.locations + counts.characters + counts.general;
        if (totalAdded > 0) {
          const guild = textChannel.guild;
          const recapChannel = findRecapChannel(guild, textChannel);

          const parts = [];
          if (counts.locations > 0) parts.push(`${counts.locations} new location${counts.locations > 1 ? 's' : ''}`);
          if (counts.characters > 0) parts.push(`${counts.characters} character description${counts.characters > 1 ? 's' : ''}`);
          if (counts.general > 0) parts.push(`${counts.general} world-building detail${counts.general > 1 ? 's' : ''}`);

          const flavorEmbed = new EmbedBuilder()
            .setTitle('Flavor Bank Updated')
            .setColor(0x9B59B6)
            .setDescription(`Updated flavor bank: Added ${parts.join(', ')}`)
            .setFooter({ text: 'Auto-extracted from session transcript' })
            .setTimestamp();

          await recapChannel.send({ embeds: [flavorEmbed] });
          log.info('Flavor bank update posted', counts);
        }
      } catch (err) {
        // Silent failure — don't block the pipeline
        log.warn('Flavor bank extraction skipped', { error: err.message });
      }
    })();
  } catch (err) {
    log.error('Auto-pipeline failed', { error: err.message, stack: err.stack });
    try {
      await textChannel.send({
        embeds: [makeEmbed(
          'Pipeline Error',
          `Something went wrong while processing your session: ${err.message}\n\nYou can still run it manually:\n\`\`\`\nnode run-pipeline.js --latest --style ${style}\n\`\`\``,
          false,
        )],
      });
    } catch { /* ignore send failure */ }
  }
}

// ─── One-shot pipeline with Discord progress updates ─────────────────

/**
 * Run the transcription + story generation pipeline for one-shot mode.
 * Uses more aggressive verification (6 passes, threshold 80) and different naming.
 */
async function runOneShotPipelineWithUpdates(textChannel, audioPath, sessionDurationMs = 0) {
  const style = config.story.defaultStyle;

  try {
    // Step 1: Transcribe
    const transcribeMsg = await textChannel.send({
      embeds: [makeEmbed('Transcribing audio...', 'Converting your one-shot session audio to text. This may take a moment.', true)],
    });

    const transcriptPath = await transcribe(audioPath, { service: undefined });
    log.info('Transcription complete (one-shot)', { transcriptPath });

    // Step 2: Generate story with one-shot settings
    await transcribeMsg.edit({
      embeds: [makeEmbed('Generating one-shot story...', `Crafting your one-shot narrative in **${style}** style with enhanced accuracy.`, true)],
    });

    const { storyPath, verificationResult } = await generateOneShotStory(transcriptPath, { style });
    log.info('One-shot story generation complete', { storyPath });

    // Step 3: Post the story to the recap channel
    await transcribeMsg.edit({
      embeds: [makeEmbed('Posting one-shot recap...', 'One-shot recap generated! Posting now.', true)],
    });

    await postOneShotRecapToDiscord(textChannel, storyPath, style, sessionDurationMs, verificationResult);

    // Update the progress message
    await transcribeMsg.edit({
      embeds: [makeEmbed(
        'Pipeline complete!',
        'One-shot recap has been generated and posted.',
        true,
      )],
    });

    // ── Fire-and-forget: extract flavor descriptions for the flavor bank ──
    (async () => {
      try {
        const transcriptText = fs.readFileSync(transcriptPath, 'utf-8');
        const storyText = fs.readFileSync(storyPath, 'utf-8');
        const campaignCtx = loadCampaignContextForRecap();

        const counts = await extractFlavorDescriptions(transcriptText, storyText, campaignCtx);
        const totalAdded = counts.locations + counts.characters + counts.general;
        if (totalAdded > 0) {
          const guild = textChannel.guild;
          const recapChannel = findRecapChannel(guild, textChannel);

          const parts = [];
          if (counts.locations > 0) parts.push(`${counts.locations} new location${counts.locations > 1 ? 's' : ''}`);
          if (counts.characters > 0) parts.push(`${counts.characters} character description${counts.characters > 1 ? 's' : ''}`);
          if (counts.general > 0) parts.push(`${counts.general} world-building detail${counts.general > 1 ? 's' : ''}`);

          const flavorEmbed = new EmbedBuilder()
            .setTitle('Flavor Bank Updated')
            .setColor(0x9B59B6)
            .setDescription(`Updated flavor bank: Added ${parts.join(', ')}`)
            .setFooter({ text: 'Auto-extracted from one-shot session transcript' })
            .setTimestamp();

          await recapChannel.send({ embeds: [flavorEmbed] });
          log.info('Flavor bank update posted (one-shot)', counts);
        }
      } catch (err) {
        // Silent failure — don't block the pipeline
        log.warn('Flavor bank extraction skipped (one-shot)', { error: err.message });
      }
    })();
  } catch (err) {
    log.error('One-shot pipeline failed', { error: err.message, stack: err.stack });
    try {
      await textChannel.send({
        embeds: [makeEmbed(
          'Pipeline Error',
          `Something went wrong while processing your one-shot session: ${err.message}\n\nYou can still run it manually:\n\`\`\`\nnode run-pipeline.js --latest --style ${style}\n\`\`\``,
          false,
        )],
      });
    } catch { /* ignore send failure */ }
  }
}

// ─── Post story to Discord ──────────────────────────────────────────

/**
 * Post the generated story to a Discord channel as a series of rich embeds.
 *
 * @param {TextChannel} fallbackChannel  Channel where !stop was typed
 * @param {string} storyPath             Path to the story markdown file
 * @param {number} chapterNum            Chapter number
 * @param {string} style                 Narrative style used
 * @param {number} sessionDurationMs     How long the recording was (ms), or 0 if unknown
 * @param {object} [verificationResult]  Verification results from story generation
 */
async function postRecapToDiscord(fallbackChannel, storyPath, chapterNum, style, sessionDurationMs = 0, verificationResult = null) {
  try {
    const guild = fallbackChannel.guild;
    const channel = findRecapChannel(guild, fallbackChannel);

    const storyContent = fs.readFileSync(storyPath, 'utf-8');
    const { title: extractedTitle, body } = extractStoryTitle(storyContent);
    const styledBody = boldFirstParagraph(body);

    const embedColor = STYLE_COLORS[style] || 0x2d1b69;
    const dateStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const styleLabel = style.charAt(0).toUpperCase() + style.slice(1);
    const accuracyStr = verificationResult?.accuracy_score != null
      ? ` \u2022 Accuracy: ${verificationResult.accuracy_score}/100`
      : '';
    const footerText = `${styleLabel} style${accuracyStr} \u2022 ${dateStr}`;

    // Build chapter title
    const chapterTitle = extractedTitle
      ? `Chapter ${chapterNum}: ${extractedTitle}`
      : `Chapter ${chapterNum}`;

    // ── Summary embed ───────────────────────────────────────────────
    const campaignCtx = loadCampaignContextForRecap();
    const pcNames = campaignCtx?.playerCharacters?.map(pc => `${pc.name} (${pc.race} ${pc.class})`).join(', ') || 'Unknown';

    let durationStr = 'Unknown';
    if (sessionDurationMs > 0) {
      const totalMin = Math.round(sessionDurationMs / 60000);
      const hrs = Math.floor(totalMin / 60);
      const mins = totalMin % 60;
      durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    }

    const summaryEmbed = new EmbedBuilder()
      .setTitle('\uD83D\uDCDC Session Recap')
      .setColor(embedColor)
      .addFields(
        { name: 'Chapter', value: String(chapterNum), inline: true },
        { name: 'Date', value: dateStr, inline: true },
        { name: 'Duration', value: durationStr, inline: true },
        { name: 'Style', value: style.charAt(0).toUpperCase() + style.slice(1), inline: true },
        { name: 'Characters', value: pcNames, inline: false },
      )
      .setFooter({ text: 'D&D Scribe Bot' })
      .setTimestamp();

    await channel.send({ embeds: [summaryEmbed] });

    // ── Story embeds (split if needed) ──────────────────────────────
    const chunks = splitForEmbeds(styledBody);
    const totalParts = chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      const partLabel = totalParts > 1 ? ` (Part ${i + 1}/${totalParts})` : '';
      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setDescription(chunks[i]);

      if (i === 0) {
        embed.setTitle(chapterTitle + partLabel);
      } else {
        embed.setTitle(`${chapterTitle}${partLabel}`);
      }

      if (i === chunks.length - 1) {
        embed.setFooter({ text: footerText });
        embed.setTimestamp();
      }

      await channel.send({ embeds: [embed] });
    }

    log.info('Story posted to Discord', { channel: channel.name, parts: totalParts });

    // If we posted to a different channel, let the original channel know
    if (channel.id !== fallbackChannel.id) {
      await fallbackChannel.send({
        embeds: [makeEmbed(
          'Story Posted!',
          `Chapter ${chapterNum} has been posted to <#${channel.id}>.`,
          true,
        )],
      });
    }
  } catch (err) {
    log.error('Failed to post recap to Discord', { error: err.message, stack: err.stack });
    try {
      await fallbackChannel.send({
        embeds: [makeEmbed(
          'Recap Post Failed',
          `Could not post the story to Discord: ${err.message}\nThe chapter is still saved to disk at \`${path.basename(storyPath)}\`.`,
          false,
        )],
      });
    } catch { /* ignore */ }
  }
}

/**
 * Post a one-shot story recap to Discord (no chapter numbering).
 */
async function postOneShotRecapToDiscord(fallbackChannel, storyPath, style, sessionDurationMs = 0, verificationResult = null) {
  try {
    const guild = fallbackChannel.guild;
    const channel = findRecapChannel(guild, fallbackChannel);

    const storyContent = fs.readFileSync(storyPath, 'utf-8');
    const { title: extractedTitle, body } = extractStoryTitle(storyContent);
    const styledBody = boldFirstParagraph(body);

    const embedColor = STYLE_COLORS[style] || 0x2d1b69;
    const dateStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const styleLabel = style.charAt(0).toUpperCase() + style.slice(1);
    const accuracyStr = verificationResult?.accuracy_score != null
      ? ` \u2022 Accuracy: ${verificationResult.accuracy_score}/100`
      : '';
    const footerText = `${styleLabel} style${accuracyStr} \u2022 ${dateStr}`;

    const recapTitle = extractedTitle
      ? `One-shot recap: ${extractedTitle}`
      : 'One-shot recap';

    // ── Summary embed ───────────────────────────────────────────────
    const campaignCtx = loadCampaignContextForRecap();
    const pcNames = campaignCtx?.playerCharacters?.map(pc => `${pc.name} (${pc.race} ${pc.class})`).join(', ') || 'Unknown';

    let durationStr = 'Unknown';
    if (sessionDurationMs > 0) {
      const totalMin = Math.round(sessionDurationMs / 60000);
      const hrs = Math.floor(totalMin / 60);
      const mins = totalMin % 60;
      durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    }

    const summaryEmbed = new EmbedBuilder()
      .setTitle('\uD83C\uDFB2 One-shot recap')
      .setColor(embedColor)
      .addFields(
        { name: 'Date', value: dateStr, inline: true },
        { name: 'Duration', value: durationStr, inline: true },
        { name: 'Style', value: styleLabel, inline: true },
        { name: 'Characters', value: pcNames, inline: false },
      )
      .setFooter({ text: 'D&D Scribe Bot \u2022 One-shot session' })
      .setTimestamp();

    await channel.send({ embeds: [summaryEmbed] });

    // ── Story embeds (split if needed) ──────────────────────────────
    const chunks = splitForEmbeds(styledBody);
    const totalParts = chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      const partLabel = totalParts > 1 ? ` (Part ${i + 1}/${totalParts})` : '';
      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setDescription(chunks[i]);

      if (i === 0) {
        embed.setTitle(recapTitle + partLabel);
      } else {
        embed.setTitle(`${recapTitle}${partLabel}`);
      }

      if (i === chunks.length - 1) {
        embed.setFooter({ text: footerText });
        embed.setTimestamp();
      }

      await channel.send({ embeds: [embed] });
    }

    log.info('One-shot story posted to Discord', { channel: channel.name, parts: totalParts });

    if (channel.id !== fallbackChannel.id) {
      await fallbackChannel.send({
        embeds: [makeEmbed(
          'One-shot recap Posted!',
          `One-shot recap has been posted to <#${channel.id}>.`,
          true,
        )],
      });
    }
  } catch (err) {
    log.error('Failed to post one-shot recap to Discord', { error: err.message, stack: err.stack });
    try {
      await fallbackChannel.send({
        embeds: [makeEmbed(
          'One-shot recap Post Failed',
          `Could not post the one-shot story to Discord: ${err.message}\nThe story is still saved to disk at \`${path.basename(storyPath)}\`.`,
          false,
        )],
      });
    } catch { /* ignore */ }
  }
}

/**
 * Find and re-post the latest story chapter to a given channel.
 * Used by the !recap command.
 */
async function repostLatestRecap(channel) {
  try {
    const storiesDir = config.paths.stories;
    if (!fs.existsSync(storiesDir)) {
      return channel.send({ embeds: [makeEmbed('No Stories Found', 'No story chapters have been generated yet.', false)] });
    }

    const chapters = fs.readdirSync(storiesDir)
      .filter(f => /^chapter-\d+/.test(f) && f.endsWith('.md'))
      .map(f => ({ name: f, time: fs.statSync(path.join(storiesDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (chapters.length === 0) {
      return channel.send({ embeds: [makeEmbed('No Stories Found', 'No story chapters have been generated yet.', false)] });
    }

    const latest = chapters[0];
    const chapterMatch = latest.name.match(/chapter-(\d+)/);
    const chapterNum = chapterMatch ? parseInt(chapterMatch[1], 10) : 0;
    const storyPath = path.join(storiesDir, latest.name);
    const style = config.story.defaultStyle;

    await postRecapToDiscord(channel, storyPath, chapterNum, style, 0);
  } catch (err) {
    log.error('Failed to repost recap', { error: err.message });
    await channel.send({ embeds: [makeEmbed('Error', `Failed to repost story: ${err.message}`, false)] });
  }
}

module.exports = {
  runPipelineWithUpdates,
  runOneShotPipelineWithUpdates,
  postRecapToDiscord,
  postOneShotRecapToDiscord,
  repostLatestRecap,
};
