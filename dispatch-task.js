#!/usr/bin/env node
/**
 * D&D Scribe Bot — Dispatch Integration
 *
 * Designed to be invoked by Claude Dispatch (or any external scheduler).
 * Processes the latest recording through the full pipeline and outputs
 * structured results to stdout for the caller to consume.
 *
 * Usage (standalone):
 *   node dispatch-task.js
 *   node dispatch-task.js --style sanderson
 *   node dispatch-task.js --audio ./recordings/session-2026-04-01.ogg
 *
 * Environment variables (for Dispatch):
 *   SCRIBE_STYLE      — 'martin' or 'sanderson' (overrides config default)
 *   SCRIBE_AUDIO_PATH — explicit audio file path (otherwise uses latest)
 *   SCRIBE_SERVICE    — transcription backend override
 */

const path = require('path');
const fs = require('fs');
const log = require('./logger');
const { runPipeline } = require('./run-pipeline');
const { findLatestRecording } = require('./transcribe');
const config = require('./config');

async function dispatch() {
  const args = process.argv.slice(2);

  // Resolve audio path from args, env, or latest
  let audioPath;
  const audioIdx = args.indexOf('--audio');
  if (audioIdx !== -1 && args[audioIdx + 1]) {
    audioPath = path.resolve(args[audioIdx + 1]);
  } else if (process.env.SCRIBE_AUDIO_PATH) {
    audioPath = path.resolve(process.env.SCRIBE_AUDIO_PATH);
  } else {
    try {
      audioPath = findLatestRecording();
    } catch {
      const result = {
        success: false,
        error: 'No recording files found. Record a session first with !record in Discord.',
      };
      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  }

  // Resolve style
  const styleIdx = args.indexOf('--style');
  const style = (styleIdx !== -1 ? args[styleIdx + 1] : null)
    || process.env.SCRIBE_STYLE
    || config.story.defaultStyle;

  // Resolve transcription service override
  const serviceIdx = args.indexOf('--service');
  const service = (serviceIdx !== -1 ? args[serviceIdx + 1] : null)
    || process.env.SCRIBE_SERVICE
    || undefined;

  log.info('Dispatch task started', { audioPath, style, service: service || 'default' });

  try {
    const { transcriptPath, storyPath, summary, chapterNum } = await runPipeline(
      audioPath, { style, service }
    );

    // Read the generated chapter for the Dispatch response
    const storyContent = fs.readFileSync(storyPath, 'utf-8');
    const wordCount = storyContent.split(/\s+/).length;

    const result = {
      success: true,
      chapterNumber: chapterNum,
      style,
      audioFile: path.basename(audioPath),
      transcriptFile: path.basename(transcriptPath),
      storyFile: path.basename(storyPath),
      wordCount,
      summary: summary || 'No summary generated.',
      paths: {
        transcript: transcriptPath,
        story: storyPath,
      },
    };

    // Output structured JSON for the Dispatch caller
    console.log('\n--- DISPATCH RESULT ---');
    console.log(JSON.stringify(result, null, 2));

    return result;
  } catch (err) {
    const result = {
      success: false,
      error: err.message,
      audioFile: path.basename(audioPath),
    };
    console.log('\n--- DISPATCH RESULT ---');
    console.log(JSON.stringify(result, null, 2));
    log.error('Dispatch task failed', { error: err.message });
    process.exit(1);
  }
}

if (require.main === module) {
  dispatch();
}

module.exports = { dispatch };
