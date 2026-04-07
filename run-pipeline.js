#!/usr/bin/env node
/**
 * D&D Scribe Bot — Full Pipeline
 *
 * Chains: transcribe → generate story → update campaign log
 *
 * Usage:
 *   node run-pipeline.js ./recordings/session-2026-04-01.ogg --style martin
 *   node run-pipeline.js --latest --style sanderson
 *   node run-pipeline.js --latest                          # uses default style from config
 */

const path = require('path');
const log = require('./logger');
const { transcribe, findLatestRecording } = require('./transcribe');
const { generateStory } = require('./generate-story');
const config = require('./config');

async function runPipeline(audioPath, opts = {}) {
  const style = opts.style || config.story.defaultStyle;
  const startTime = Date.now();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           D&D Scribe Bot — Pipeline             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  // ── Step 1: Transcribe ──────────────────────────────────────────
  console.log('Step 1/3: Transcribing audio...');
  console.log(`  Audio:   ${path.basename(audioPath)}`);
  console.log(`  Service: ${config.transcription.service}`);
  console.log();

  const transcriptPath = await transcribe(audioPath, { service: opts.service });
  console.log(`  ✓ Transcript saved: ${transcriptPath}`);
  console.log();

  // ── Step 2: Generate Story ──────────────────────────────────────
  console.log(`Step 2/3: Generating story (${style} style)...`);
  console.log(`  Model: ${config.anthropic.model}`);
  console.log();

  const { storyPath, summary, chapterNum } = await generateStory(transcriptPath, { style });
  console.log(`  ✓ Chapter ${chapterNum} saved: ${storyPath}`);
  if (summary) {
    console.log(`  ✓ Campaign log updated`);
    console.log();
    console.log(`  Summary: ${summary}`);
  }
  console.log();

  // ── Done ────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('═══════════════════════════════════════════════════');
  console.log(`Pipeline complete in ${elapsed}s`);
  console.log(`  Transcript: ${transcriptPath}`);
  console.log(`  Chapter:    ${storyPath}`);
  console.log('═══════════════════════════════════════════════════');

  return { transcriptPath, storyPath, summary, chapterNum };
}

// ─── CLI ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
D&D Scribe Bot — Pipeline

Usage:
  node run-pipeline.js <audio-file> [options]
  node run-pipeline.js --latest [options]

Options:
  --latest              Use the most recent recording file
  --style <style>       Narrative style: martin or sanderson (default: ${config.story.defaultStyle})
  --service <service>   Override transcription service: whisper-local, assemblyai, deepgram
  --help, -h            Show this help
`);
    process.exit(0);
  }

  let audioPath;
  if (args.includes('--latest')) {
    audioPath = findLatestRecording();
    console.log(`Using latest recording: ${path.basename(audioPath)}\n`);
  } else {
    const nonFlags = args.filter(a => !a.startsWith('--'));
    if (nonFlags.length === 0) {
      console.error('Error: Provide an audio file path or use --latest');
      console.error('Run with --help for usage information.');
      process.exit(1);
    }
    audioPath = path.resolve(nonFlags[0]);
  }

  const styleIdx = args.indexOf('--style');
  const style = styleIdx !== -1 ? args[styleIdx + 1] : undefined;

  const serviceIdx = args.indexOf('--service');
  const service = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

  try {
    await runPipeline(audioPath, { style, service });
  } catch (err) {
    log.error('Pipeline failed', { error: err.message, stack: err.stack });
    console.error(`\nPipeline failed: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runPipeline };
