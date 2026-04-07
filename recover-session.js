#!/usr/bin/env node
/**
 * D&D Scribe Bot — Session Recovery Script
 *
 * Recovers a crashed recording session by mixing per-user PCM audio files
 * back into a single OGG file and running the transcription + story pipeline.
 *
 * The bot records each Discord user's audio as a separate `_tmp_*.pcm` file.
 * If the bot crashes mid-session, these temp files remain on disk. This script
 * finds them, mixes them together with ffmpeg, and feeds the result through
 * the normal transcribe -> generateStory pipeline.
 *
 * PCM format (Discord default): 48kHz, 16-bit signed little-endian, stereo
 *
 * Usage:
 *   node recover-session.js
 *   node recover-session.js --style sanderson
 *   node recover-session.js --service assemblyai
 *   node recover-session.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const config = require('./config');
const log = require('./logger');
const { transcribe } = require('./transcribe');
const { generateStory } = require('./generate-story');

// ─── Constants ─────────────────────────────────────────────────────
const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_SAMPLE_FMT = 's16le'; // 16-bit signed little-endian
const BYTES_PER_SAMPLE = 2; // 16-bit = 2 bytes
const BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_CHANNELS * BYTES_PER_SAMPLE;
const MIN_FILE_SIZE = 1024; // ignore files smaller than 1 KB (likely empty/corrupt)

// ─── Helpers ───────────────────────────────────────────────────────

function dateString() {
  return new Date().toISOString().slice(0, 10);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: args.includes('--dry-run'),
    style: undefined,
    service: undefined,
  };

  const styleIdx = args.indexOf('--style');
  if (styleIdx !== -1 && args[styleIdx + 1]) opts.style = args[styleIdx + 1];

  const serviceIdx = args.indexOf('--service');
  if (serviceIdx !== -1 && args[serviceIdx + 1]) opts.service = args[serviceIdx + 1];

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
D&D Scribe Bot - Session Recovery

Recovers crashed recording sessions by mixing per-user PCM files
into a single OGG and running the transcription/story pipeline.

Usage:
  node recover-session.js [options]

Options:
  --style <style>       Narrative style: martin or sanderson (default: ${config.story.defaultStyle})
  --service <service>   Transcription service: whisper-local, assemblyai, deepgram
  --dry-run             Show what would be done without doing it
  --help, -h            Show this help
`);
    process.exit(0);
  }

  return opts;
}

// ─── Step 1: Find and analyze PCM files ────────────────────────────

function findPcmFiles() {
  const recDir = config.paths.recordings;

  if (!fs.existsSync(recDir)) {
    throw new Error(`Recordings directory not found: ${recDir}`);
  }

  const allFiles = fs.readdirSync(recDir)
    .filter(f => f.startsWith('_tmp_') && f.endsWith('.pcm'))
    .map(f => {
      const fullPath = path.join(recDir, f);
      const stat = fs.statSync(fullPath);
      return {
        name: f,
        path: fullPath,
        size: stat.size,
        modified: stat.mtime,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (allFiles.length === 0) {
    throw new Error(`No _tmp_*.pcm files found in ${recDir}`);
  }

  return allFiles;
}

function analyzePcmFiles(files) {
  console.log('\n--- PCM File Analysis ---\n');

  // Parse the filename pattern: _tmp_{guildId}_{userId}_{timestamp}.pcm
  const userMap = new Map();

  for (const file of files) {
    const match = file.name.match(/_tmp_(\d+)_(\d+)_(\d+)\.pcm/);
    const userId = match ? match[2] : 'unknown';
    const guildId = match ? match[1] : 'unknown';
    const timestamp = match ? parseInt(match[3], 10) : 0;

    if (!userMap.has(userId)) userMap.set(userId, []);
    userMap.get(userId).push({ ...file, guildId, userId, timestamp });

    const durationSec = file.size / BYTES_PER_SECOND;
    const status = file.size < MIN_FILE_SIZE ? ' (SKIPPED - too small)' : '';

    console.log(`  ${file.name}`);
    console.log(`    User ID:  ${userId}`);
    console.log(`    Size:     ${formatBytes(file.size)}`);
    console.log(`    Duration: ~${formatDuration(durationSec)}${status}`);
    console.log();
  }

  // Filter to only usable files
  const usable = files.filter(f => f.size >= MIN_FILE_SIZE);
  const skipped = files.length - usable.length;

  const totalSize = usable.reduce((sum, f) => sum + f.size, 0);
  const uniqueUsers = new Set(usable.map(f => {
    const m = f.name.match(/_tmp_\d+_(\d+)_/);
    return m ? m[1] : f.name;
  }));

  console.log(`--- Summary ---`);
  console.log(`  Total PCM files: ${files.length}`);
  console.log(`  Usable files:    ${usable.length} (>= ${formatBytes(MIN_FILE_SIZE)})`);
  console.log(`  Skipped:         ${skipped} (empty/tiny)`);
  console.log(`  Unique users:    ${uniqueUsers.size}`);
  console.log(`  Total raw size:  ${formatBytes(totalSize)}`);
  console.log();

  return { usable, skipped, uniqueUsers: uniqueUsers.size, totalSize };
}

// ─── Step 2: Mix PCM files with ffmpeg ─────────────────────────────

function mixPcmToOgg(pcmFiles, outputPath) {
  return new Promise((resolve, reject) => {
    if (pcmFiles.length === 0) {
      return reject(new Error('No usable PCM files to mix'));
    }

    const ffmpegPath = config.audio.ffmpegPath || 'ffmpeg';

    // Verify ffmpeg is available
    try {
      execSync(`"${ffmpegPath}" -version`, { stdio: 'pipe' });
    } catch {
      throw new Error(
        'ffmpeg not found. Install it or set FFMPEG_PATH in your .env file.\n' +
        'Download: https://ffmpeg.org/download.html'
      );
    }

    // Build ffmpeg command:
    //   - Each PCM file is an input with raw PCM format specifiers
    //   - Use amix filter to mix all inputs together
    //   - Output as OGG (libvorbis)
    const args = [];

    // Input specifications for each PCM file
    for (const file of pcmFiles) {
      args.push(
        '-f', PCM_SAMPLE_FMT,
        '-ar', String(PCM_SAMPLE_RATE),
        '-ac', String(PCM_CHANNELS),
        '-i', file.path
      );
    }

    // Filter: mix all inputs together
    if (pcmFiles.length === 1) {
      // Single file - no mixing needed, just convert
      args.push('-c:a', 'libvorbis', '-q:a', '4');
    } else {
      // Multiple files - use amix filter
      args.push(
        '-filter_complex',
        `amix=inputs=${pcmFiles.length}:duration=longest:dropout_transition=2,dynaudnorm`,
        '-c:a', 'libvorbis',
        '-q:a', '4'
      );
    }

    // Overwrite output without prompting
    args.push('-y', outputPath);

    console.log(`\nMixing ${pcmFiles.length} PCM stream(s) into OGG...`);
    console.log(`  Output: ${path.basename(outputPath)}`);
    log.info('Running ffmpeg mix', { inputs: pcmFiles.length, output: outputPath });

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      // Parse ffmpeg progress from stderr
      const timeMatch = data.toString().match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch) {
        process.stdout.write(`\r  Progress: ${timeMatch[1]}    `);
      }
    });

    ffmpeg.on('close', (code) => {
      process.stdout.write('\n');

      if (code !== 0) {
        log.error('ffmpeg failed', { code, stderr: stderr.slice(-500) });
        return reject(new Error(
          `ffmpeg exited with code ${code}.\n` +
          `Last output: ${stderr.slice(-300)}`
        ));
      }

      // Verify output exists and has content
      if (!fs.existsSync(outputPath)) {
        return reject(new Error('ffmpeg completed but output file was not created'));
      }

      const outStat = fs.statSync(outputPath);
      if (outStat.size === 0) {
        fs.unlinkSync(outputPath);
        return reject(new Error('ffmpeg produced an empty output file'));
      }

      console.log(`  Mixed successfully: ${formatBytes(outStat.size)}`);
      log.info('ffmpeg mix complete', { outputSize: outStat.size });
      resolve(outputPath);
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
  });
}

// ─── Step 3: Run the pipeline ──────────────────────────────────────

async function runRecoveryPipeline(audioPath, opts = {}) {
  const style = opts.style || config.story.defaultStyle;
  const service = opts.service;

  console.log('\n--- Transcription ---\n');
  console.log(`  Service: ${service || config.transcription.service}`);
  console.log(`  Audio:   ${path.basename(audioPath)}`);
  console.log();

  let transcriptPath = await transcribe(audioPath, { service });

  // Rename transcript to include "-recovered" so it doesn't clash with
  // a new session's transcript when the bot is restarted.
  const dir = path.dirname(transcriptPath);
  const ext = path.extname(transcriptPath);
  const base = path.basename(transcriptPath, ext);
  const recoveredName = `${base}-recovered${ext}`;
  const recoveredPath = path.join(dir, recoveredName);

  // Avoid overwriting an existing recovered transcript
  if (fs.existsSync(recoveredPath)) {
    const ts = Date.now();
    const altPath = path.join(dir, `${base}-recovered-${ts}${ext}`);
    fs.renameSync(transcriptPath, altPath);
    transcriptPath = altPath;
  } else {
    fs.renameSync(transcriptPath, recoveredPath);
    transcriptPath = recoveredPath;
  }

  console.log(`  Transcript saved: ${transcriptPath}`);

  console.log('\n--- Story Generation ---\n');
  console.log(`  Style:   ${style}`);
  console.log(`  Model:   ${config.anthropic.model}`);
  console.log();

  const { storyPath, summary, chapterNum } = await generateStory(transcriptPath, { style });
  console.log(`  Chapter ${chapterNum} saved: ${storyPath}`);

  if (summary) {
    console.log(`  Campaign log updated`);
    console.log(`\n  Summary: ${summary}`);
  }

  return { transcriptPath, storyPath, summary, chapterNum };
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log('============================================');
  console.log('  D&D Scribe Bot - Session Recovery Tool');
  console.log('============================================');
  console.log();
  console.log(`  Date: ${dateString()}`);
  console.log(`  Mode: ${opts.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);

  try {
    // Step 1: Find and analyze PCM files
    console.log('\n[1/3] Scanning for PCM files...');
    const allFiles = findPcmFiles();
    const { usable, skipped, uniqueUsers, totalSize } = analyzePcmFiles(allFiles);

    if (usable.length === 0) {
      console.error('\nNo usable PCM files found (all files are empty or too small).');
      console.error('The recording may not have captured any audio before the crash.');
      process.exit(1);
    }

    if (opts.dryRun) {
      console.log('\n[DRY RUN] Would mix the following files:');
      for (const f of usable) {
        console.log(`  - ${f.name} (${formatBytes(f.size)})`);
      }
      console.log(`\nOutput would be: session-${dateString()}-recovered.ogg`);
      console.log('Exiting dry run.');
      process.exit(0);
    }

    // Step 2: Mix PCM to OGG
    console.log('[2/3] Mixing audio streams...');
    const outputName = `session-${dateString()}-recovered.ogg`;
    const outputPath = path.join(config.paths.recordings, outputName);

    // Check if output already exists
    if (fs.existsSync(outputPath)) {
      const timestamp = Date.now();
      const altName = `session-${dateString()}-recovered-${timestamp}.ogg`;
      const altPath = path.join(config.paths.recordings, altName);
      console.log(`  Note: ${outputName} already exists, using ${altName}`);
      await mixPcmToOgg(usable, altPath);
      var finalOutputPath = altPath;
    } else {
      await mixPcmToOgg(usable, outputPath);
      var finalOutputPath = outputPath;
    }

    // Step 3: Transcription + Story
    console.log('\n[3/3] Running transcription & story pipeline...');
    const result = await runRecoveryPipeline(finalOutputPath, {
      style: opts.style,
      service: opts.service,
    });

    // Done
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n============================================');
    console.log('  Recovery Complete!');
    console.log('============================================');
    console.log(`  Time:       ${elapsed}s`);
    console.log(`  Audio:      ${path.basename(finalOutputPath)}`);
    console.log(`  Transcript: ${path.basename(result.transcriptPath)}`);
    console.log(`  Story:      ${path.basename(result.storyPath)}`);
    console.log(`  Chapter:    #${result.chapterNum}`);
    console.log('============================================');

  } catch (err) {
    log.error('Recovery failed', { error: err.message, stack: err.stack });
    console.error(`\nRecovery failed: ${err.message}`);

    if (err.message.includes('ffmpeg')) {
      console.error('\nTroubleshooting:');
      console.error('  - Ensure ffmpeg is installed and on your PATH');
      console.error('  - Or set FFMPEG_PATH in your .env file');
      console.error('  - Download: https://ffmpeg.org/download.html');
    }

    if (err.message.includes('API key') || err.message.includes('YOUR_')) {
      console.error('\nTroubleshooting:');
      console.error('  - Check your .env file for valid API keys');
      console.error('  - The transcription/story steps require configured API keys');
    }

    process.exit(1);
  }
}

// Run
main();
