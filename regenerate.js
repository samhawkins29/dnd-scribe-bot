#!/usr/bin/env node
/**
 * D&D Scribe Bot — Story Regeneration Script
 *
 * Regenerates the story from the combined/recovered transcript using
 * the updated pipeline with verification. Replaces old chapter files
 * and resets the campaign log.
 *
 * Usage:
 *   node regenerate.js
 *   node regenerate.js --style sanderson
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const { generateStory } = require('./generate-story');

async function main() {
  const args = process.argv.slice(2);
  const styleIdx = args.indexOf('--style');
  const style = styleIdx !== -1 ? args[styleIdx + 1] : config.story.defaultStyle;

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       D&D Scribe Bot — Story Regeneration       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  // Find the combined/recovered transcript
  const transcriptDir = config.paths.transcripts;
  const transcriptFiles = fs.readdirSync(transcriptDir)
    .filter(f => f.endsWith('.txt'))
    .sort((a, b) => {
      // Prefer files with "combined" or "recovered" in the name
      const aScore = (a.includes('combined') || a.includes('recovered')) ? 1 : 0;
      const bScore = (b.includes('combined') || b.includes('recovered')) ? 1 : 0;
      if (aScore !== bScore) return bScore - aScore;
      return fs.statSync(path.join(transcriptDir, b)).mtimeMs -
             fs.statSync(path.join(transcriptDir, a)).mtimeMs;
    });

  if (transcriptFiles.length === 0) {
    console.error('No transcript files found in', transcriptDir);
    process.exit(1);
  }

  const transcriptPath = path.join(transcriptDir, transcriptFiles[0]);
  console.log(`Transcript: ${transcriptFiles[0]}`);
  console.log(`Style:      ${style}`);
  console.log();

  // Remove old chapter files
  const storiesDir = config.paths.stories;
  if (fs.existsSync(storiesDir)) {
    const oldChapters = fs.readdirSync(storiesDir)
      .filter(f => f.startsWith('chapter-') && f.endsWith('.md'));
    for (const ch of oldChapters) {
      fs.unlinkSync(path.join(storiesDir, ch));
      console.log(`  Removed old: ${ch}`);
    }
  }

  // Reset campaign log
  fs.writeFileSync(config.paths.campaignLog, '# Campaign Log\n', 'utf-8');
  console.log('  Campaign log reset');
  console.log();

  // Generate new story with verification
  console.log('Generating story with verification pipeline...');
  console.log();

  try {
    const result = await generateStory(transcriptPath, { style });

    console.log();
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Chapter ${result.chapterNum} saved: ${result.storyPath}`);

    if (result.verificationResult) {
      const vr = result.verificationResult;
      console.log();
      console.log('  VERIFICATION RESULTS:');
      console.log(`    Accuracy Score: ${vr.accuracy_score}/100`);
      console.log(`    Fabrications:   ${vr.fabrications?.length || 0}`);
      console.log(`    Omissions:      ${vr.omissions?.length || 0}`);

      if (vr.fabrications?.length > 0) {
        console.log();
        console.log('    Fabrications found:');
        for (const f of vr.fabrications) {
          console.log(`      - ${f.claim}`);
        }
      }

      if (vr.omissions?.length > 0) {
        console.log();
        console.log('    Omissions found:');
        for (const o of vr.omissions) {
          console.log(`      - ${o.event}`);
        }
      }
    }

    if (result.summary) {
      console.log();
      console.log(`  Summary: ${result.summary}`);
    }

    console.log('═══════════════════════════════════════════════════');
  } catch (err) {
    log.error('Regeneration failed', { error: err.message, stack: err.stack });
    console.error(`\nRegeneration failed: ${err.message}`);
    process.exit(1);
  }
}

main();
