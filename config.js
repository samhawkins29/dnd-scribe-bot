/**
 * D&D Scribe Bot — Configuration
 *
 * Copy .env.example to .env and fill in your API keys,
 * or edit the defaults below directly (not recommended for secrets).
 */

require('dotenv').config({ override: true });
const path = require('path');

const config = {
  // ─── Discord ───────────────────────────────────────────────────────
  discord: {
    token: process.env.DISCORD_BOT_TOKEN || 'YOUR_DISCORD_BOT_TOKEN_HERE',
    clientId: process.env.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID_HERE',
    guildId: process.env.DISCORD_GUILD_ID || '',  // optional: restrict slash commands to one server
  },

  // ─── Anthropic (Claude) ────────────────────────────────────────────
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY_HERE',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 8192,
    // Output budget for passes that echo the whole transcript back
    // (classifier, corrector). Must be large enough that a multi-hour
    // session isn't silently truncated mid-response. Sonnet 4 supports up
    // to 64K output tokens; 32K comfortably handles a multi-hour session,
    // and the classifier also chunks long input so it never relies on a
    // single response covering everything.
    transcriptMaxTokens: parseInt(process.env.ANTHROPIC_TRANSCRIPT_MAX_TOKENS, 10) || 32768,
  },

  // ─── Transcription ────────────────────────────────────────────────
  transcription: {
    /**
     * Which transcription backend to use.
     * Options: 'whisper-local' | 'assemblyai' | 'deepgram'
     */
    service: process.env.TRANSCRIPTION_SERVICE || 'whisper-local',

    whisper: {
      // Path to the whisper CLI (Python package) or whisper.cpp binary.
      binaryPath: process.env.WHISPER_BINARY || 'whisper',
      model: process.env.WHISPER_MODEL || 'base',        // tiny | base | small | medium | large
      language: process.env.WHISPER_LANGUAGE || 'en',
      // If using whisper.cpp, point to the model file:
      cppModelPath: process.env.WHISPER_CPP_MODEL || '',
    },

    assemblyai: {
      apiKey: process.env.ASSEMBLYAI_API_KEY || 'YOUR_ASSEMBLYAI_KEY_HERE',
      speakerLabels: true,               // enable speaker diarization
      languageCode: 'en',
    },

    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY || 'YOUR_DEEPGRAM_KEY_HERE',
      model: 'nova-2',
      diarize: true,                     // enable speaker diarization
      punctuate: true,
      language: 'en',
    },
  },

  // ─── Story Generation ─────────────────────────────────────────────
  story: {
    /**
     * Default narrative style.
     * Options: 'martin' | 'sanderson'
     */
    defaultStyle: process.env.DEFAULT_STYLE || 'martin',

    /**
     * How closely the narrative sticks to the transcript.
     * Options: 'strict' | 'balanced' | 'creative' | 'transcript-only'
     */
    creativity: process.env.STORY_CREATIVITY || 'balanced',
  },

  // ─── Recap Channel ───────────────────────────────────────────────
  recap: {
    /** Channel name (case-insensitive partial match) to post stories to after pipeline completes. */
    channelName: process.env.RECAP_CHANNEL_NAME || 'recap',
  },

  // ─── Audio / Recording ────────────────────────────────────────────
  audio: {
    /**
     * Output format for recorded sessions.
     * 'ogg' — smaller, widely supported
     * 'pcm' — raw, lossless (large files)
     */
    format: process.env.AUDIO_FORMAT || 'ogg',
    sampleRate: 48000,
    channels: 2,
    // ffmpeg path (needs to be installed system-wide or specify full path)
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  // ─── Verification ────────────────────────────────────────────────
  verification: {
    campaignThreshold: parseInt(process.env.CAMPAIGN_VERIFICATION_THRESHOLD, 10) || 70,
    oneShotThreshold: parseInt(process.env.ONESHOT_VERIFICATION_THRESHOLD, 10) || 80,
    // Each attempt resends the full transcript (generate) plus a verifier call
    // (transcript + story). Defaults trimmed from 4/10 to bound spend on long
    // sessions; the dollar ceiling below short-circuits the loop earlier still.
    campaignMaxAttempts: parseInt(process.env.CAMPAIGN_MAX_VERIFICATION_ATTEMPTS, 10) || 3,
    oneShotMaxAttempts: parseInt(process.env.ONESHOT_MAX_VERIFICATION_ATTEMPTS, 10) || 4,
  },

  // ─── Cost controls ───────────────────────────────────────────────
  cost: {
    /**
     * Hard ceiling (USD) on a single story generation, counting the initial
     * call + all verification regenerations + verifier calls. When the next
     * attempt's estimated cost would push past this, the loop stops and keeps
     * the best story so far. Set to 0 to disable the ceiling.
     */
    storyMaxUsd: parseFloat(process.env.STORY_MAX_USD) || 5,
  },

  // ─── Paths ────────────────────────────────────────────────────────
  paths: {
    recordings: path.resolve(__dirname, 'recordings'),
    transcripts: path.resolve(__dirname, 'transcripts'),
    stories: path.resolve(__dirname, 'stories'),
    lore: path.resolve(__dirname, 'lore'),
    logs: path.resolve(__dirname, 'logs'),
    campaignContext: path.resolve(__dirname, 'lore', 'campaign-context.json'),
    oneshotContext: path.resolve(__dirname, 'lore', 'oneshot-context.json'),
    campaignLog: path.resolve(__dirname, 'stories', 'campaign-log.md'),
    sessionsLog: path.resolve(__dirname, 'stories', 'sessions.json'),
  },

  // ─── Logging ──────────────────────────────────────────────────────
  logging: {
    level: process.env.LOG_LEVEL || 'info',   // debug | info | warn | error
    file: true,                                // write logs to ./logs/
  },
};

module.exports = config;
