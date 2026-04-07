#!/usr/bin/env node
/**
 * Tests for lore/campaign-context.json
 *
 * Validates JSON structure, required fields, and character schema.
 */

const fs = require('fs');
const path = require('path');
const {
  suite, test, assertEqual, assertTrue,
  assertType, assertHasProperty, assertArray, assertGreaterThan,
  assertIncludes,
} = require('./test-runner');

const config = require('../config');

suite('campaign-context.json — Valid JSON');

let campaignContext;

test('campaign-context.json exists', () => {
  assertTrue(fs.existsSync(config.paths.campaignContext), 'campaign-context.json should exist');
});

test('campaign-context.json is valid JSON', () => {
  const raw = fs.readFileSync(config.paths.campaignContext, 'utf-8');
  campaignContext = JSON.parse(raw); // will throw if invalid
  assertType(campaignContext, 'object');
});

suite('campaign-context.json — Required Top-Level Fields');

test('has campaignName field', () => {
  assertHasProperty(campaignContext, 'campaignName');
  assertType(campaignContext.campaignName, 'string');
});

test('has setting field', () => {
  assertHasProperty(campaignContext, 'setting');
  assertType(campaignContext.setting, 'string');
});

test('has playerCharacters array', () => {
  assertHasProperty(campaignContext, 'playerCharacters');
  assertArray(campaignContext.playerCharacters);
});

test('has recurringNPCs array', () => {
  assertHasProperty(campaignContext, 'recurringNPCs');
  assertArray(campaignContext.recurringNPCs);
});

test('has majorPlotThreads array', () => {
  assertHasProperty(campaignContext, 'majorPlotThreads');
  assertArray(campaignContext.majorPlotThreads);
});

test('has locationsVisited array', () => {
  assertHasProperty(campaignContext, 'locationsVisited');
  assertArray(campaignContext.locationsVisited);
});

test('has itemsOfSignificance array', () => {
  assertHasProperty(campaignContext, 'itemsOfSignificance');
  assertArray(campaignContext.itemsOfSignificance);
});

suite('campaign-context.json — Player Character Schema');

test('playerCharacters is non-empty', () => {
  assertGreaterThan(campaignContext.playerCharacters.length, 0);
});

test('each player character has name', () => {
  for (const pc of campaignContext.playerCharacters) {
    assertHasProperty(pc, 'name');
    assertType(pc.name, 'string');
    assertTrue(pc.name.length > 0, 'Character name should not be empty');
  }
});

test('each player character has race', () => {
  for (const pc of campaignContext.playerCharacters) {
    assertHasProperty(pc, 'race');
    assertType(pc.race, 'string');
  }
});

test('each player character has class', () => {
  for (const pc of campaignContext.playerCharacters) {
    assertHasProperty(pc, 'class');
    assertType(pc.class, 'string');
  }
});

test('each player character has backstory', () => {
  for (const pc of campaignContext.playerCharacters) {
    assertHasProperty(pc, 'backstory');
    assertType(pc.backstory, 'string');
  }
});

test('each player character has playerName', () => {
  for (const pc of campaignContext.playerCharacters) {
    assertHasProperty(pc, 'playerName');
    assertType(pc.playerName, 'string');
  }
});

test('each player character has level (number)', () => {
  for (const pc of campaignContext.playerCharacters) {
    assertHasProperty(pc, 'level');
    assertType(pc.level, 'number');
    assertTrue(pc.level > 0, 'Level should be positive');
    assertTrue(pc.level <= 20, 'Level should be ≤20');
  }
});

suite('campaign-context.json — NPC Schema');

test('each NPC has name', () => {
  for (const npc of campaignContext.recurringNPCs) {
    assertHasProperty(npc, 'name');
    assertType(npc.name, 'string');
  }
});

test('each NPC has role or description', () => {
  for (const npc of campaignContext.recurringNPCs) {
    const hasRole = 'role' in npc && npc.role;
    const hasDesc = 'description' in npc && npc.description;
    assertTrue(hasRole || hasDesc, `NPC "${npc.name}" should have role or description`);
  }
});

suite('campaign-context.json — Optional Fields');

test('worldNotes is an object if present', () => {
  if ('worldNotes' in campaignContext) {
    assertType(campaignContext.worldNotes, 'object');
  } else {
    assertTrue(true); // Optional field
  }
});

test('sessionCount is a number if present', () => {
  if ('sessionCount' in campaignContext) {
    assertType(campaignContext.sessionCount, 'number');
    assertTrue(campaignContext.sessionCount >= 0);
  } else {
    assertTrue(true);
  }
});

test('lastSessionDate is a string if present', () => {
  if ('lastSessionDate' in campaignContext) {
    assertType(campaignContext.lastSessionDate, 'string');
  } else {
    assertTrue(true);
  }
});

suite('campaign-context.json — Content Validation');

test('majorPlotThreads entries are non-empty strings', () => {
  for (const thread of campaignContext.majorPlotThreads) {
    assertType(thread, 'string');
    assertTrue(thread.length > 0, 'Plot thread should not be empty');
  }
});

test('locationsVisited entries are non-empty strings', () => {
  for (const loc of campaignContext.locationsVisited) {
    assertType(loc, 'string');
    assertTrue(loc.length > 0, 'Location should not be empty');
  }
});

test('itemsOfSignificance entries are non-empty strings', () => {
  for (const item of campaignContext.itemsOfSignificance) {
    assertType(item, 'string');
    assertTrue(item.length > 0, 'Item should not be empty');
  }
});
