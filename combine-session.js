#!/usr/bin/env node
/**
 * D&D Scribe Bot — Session Combiner
 *
 * Combines multiple transcript files from a split session (e.g., after a
 * bot crash and restart) into a single transcript, then generates one
 * unified story chapter.
 *
 * Usage:
 *   node combine-session.js
 *   node combine-session.js --style martin
 *   node combine-session.js --style sanderson
 *   node combine-session.js --files transcripts/file1.txt transcripts/file2.txt
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const { generateStory } = require('./generate-story');

// ─── Helpers ────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { style: undefined, files: [] };

  const styleIdx = args.indexOf('--style');
  if (styleIdx !== -1 && args[styleIdx + 1]) {
    opts.style = args[styleIdx + 1];
  }

  const filesIdx = args.indexOf('--files');
  if (filesIdx !== -1) {
    // Collect all args after --files that aren't other flags
    for (let i = filesIdx + 1; i < args.length; i++) {
      if (args[i].startsWith('--')) break;
      opts.files.push(args[i]);
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
D&D Scribe Bot - Session Combiner

Combines split session transcripts into one and generates a unified story chapter.

Usage:
  node combine-session.js [options]

Options:
  --style <style>          Narrative style: martin or sanderson (default: ${config.story.defaultStyle})
  --files <f1> <f2> ...    Manually specify transcript files to combine
  --help, -h               Show this help

Examples:
  node combine-session.js
  node combine-session.js --style sanderson
  node combine-session.js --files transcripts/session-2026-04-04-recovered.txt transcripts/session-2026-04-05.txt
`);
    process.exit(0);
  }

  return opts;
}

// ─── Transcript discovery ───────────────────────────────────────────

/**
 * Find transcript files from today and yesterday to handle midnight
 * crossover (session starts Friday night, ends Saturday morning).
 * Returns files sorted by modification time (oldest first).
 */
function findSessionTranscripts() {
  const dir = config.paths.transcripts;
  if (!fs.existsSync(dir)) {
    throw new Error(`Transcripts directory not found: ${dir}`);
  }

  const today = todayStr();
  const yesterday = yesterdayStr();

  const files = fs.readdirSync(dir)
    .filter(f => {
      if (!f.endsWith('.txt')) return false;
      // Match transcripts from today or yesterday
      return f.includes(today) || f.includes(yesterday);
    })
    .map(f => {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      return { name: f, path: fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime); // oldest first = chronological

  return files;
}

/**
 * Resolve manually specified file paths.
 */
function resolveManualFiles(filePaths) {
  const resolved = [];
  for (const fp of filePaths) {
    const fullPath = path.resolve(fp);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }
    const stat = fs.statSync(fullPath);
    resolved.push({
      name: path.basename(fullPath),
      path: fullPath,
      mtime: stat.mtimeMs,
    });
  }
  // Sort chronologically
  return resolved.sort((a, b) => a.mtime - b.mtime);
}

// ─── Combine logic ──────────────────────────────────────────────────

function combineTranscripts(files) {
  const parts = [];

  for (let i = 0; i < files.length; i++) {
    const content = fs.readFileSync(files[i].path, 'utf-8').trim();
    if (!content) {
      console.log(`  Warning: ${files[i].name} is empty, skipping.`);
      continue;
    }

    if (i === 0) {
      parts.push(content);
    } else {
      parts.push(`--- PART ${i + 1} ---\n\n${content}`);
    }
  }

  if (parts.length === 0) {
    throw new Error('All transcript files are empty.');
  }

  return parts.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log('============================================');
  console.log('  D&D Scribe Bot - Session Combiner');
  console.log('============================================');
  console.log();

  // ── Step 1: Find transcripts ────────────────────────────────────

  let files;

  if (opts.files.length > 0) {
    console.log('Using manually specified files...');
    files = resolveManualFiles(opts.files);
  } else {
    console.log('Auto-detecting transcripts from today/yesterday...');
    files = findSessionTranscripts();
  }

  if (files.length === 0) {
    console.error('\nNo transcript files found.');
    console.error('Try specifying files manually:');
    console.error('  node combine-session.js --files transcripts/file1.txt transcripts/file2.txt');
    process.exit(1);
  }

  console.log(`\nFound ${files.length} transcript(s):\n`);
  for (const f of files) {
    const size = fs.statSync(f.path).size;
    const lines = fs.readFileSync(f.path, 'utf-8').split('\n').length;
    console.log(`  ${f.name}  (${lines} lines, ${(size / 1024).toFixed(1)} KB)`);
  }

  // ── Step 2: Combine if needed ───────────────────────────────────

  let transcriptPath;

  if (files.length === 1) {
    console.log('\nOnly one transcript found — using it directly.');
    transcriptPath = files[0].path;
  } else {
    console.log('\nCombining transcripts...');

    const combined = combineTranscripts(files);
    const dateStr = todayStr();
    const combinedName = `session-${dateStr}-combined.txt`;
    transcriptPath = path.join(config.paths.transcripts, combinedName);

    fs.mkdirSync(config.paths.transcripts, { recursive: true });
    fs.writeFileSync(transcriptPath, combined, 'utf-8');

    const lineCount = combined.split('\n').length;
    console.log(`  Saved: ${combinedName} (${lineCount} lines)`);
  }

  // ── Step 3: Generate story ──────────────────────────────────────

  const style = opts.style || config.story.defaultStyle;
  console.log(`\nGenerating story (style: ${style})...`);
  console.log(`  Model: ${config.anthropic.model}`);
  console.log();

  try {
    const { storyPath, summary, chapterNum } = await generateStory(transcriptPath, { style });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n============================================');
    console.log('  Session Combined Successfully!');
    console.log('============================================');
    console.log(`  Time:       ${elapsed}s`);
    console.log(`  Transcript: ${path.basename(transcriptPath)}`);
    console.log(`  Story:      ${path.basename(storyPath)}`);
    console.log(`  Chapter:    #${chapterNum}`);
    if (summary) {
      console.log(`\n  Summary: ${summary}`);
    }
    console.log('============================================');

  } catch (err) {
    log.error('Story generation failed', { error: err.message });
    console.error(`\nStory generation failed: ${err.message}`);
    process.exit(1);
  }
}

main();
