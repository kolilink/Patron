#!/usr/bin/env node
'use strict';

// Pre-merge consistency gate — run via `npm run check`. Blocks on the two
// invariants CLAUDE.md documents as load-bearing for keeping the codebase
// legible to both humans and coding agents: palette-only colors, <Screen>
// as every screen root. See scripts/lib/consistency-checks.js for rules.

const { findHexViolations, findScreenViolations } = require('./lib/consistency-checks');

const hexViolations = findHexViolations();
const screenViolations = findScreenViolations();

let failed = false;

if (hexViolations.length) {
  failed = true;
  console.error(`\n✗ Hardcoded hex colors (${hexViolations.length}) — use palette tokens from useTheme() instead:\n`);
  hexViolations.forEach(l => console.error(`  ${l}`));
}

if (screenViolations.length) {
  failed = true;
  console.error(`\n✗ Screens not using <Screen> as root (${screenViolations.length}) — every screen must render <Screen>, not a raw <SafeAreaView>:\n`);
  screenViolations.forEach(l => console.error(`  ${l}`));
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log('✓ Consistency check passed (no hardcoded hex, all screens use <Screen>).');
