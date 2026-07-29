#!/usr/bin/env node
'use strict';

// Pre-merge consistency gate — run via `npm run check`. Blocks on the
// invariants CLAUDE.md documents as load-bearing for keeping the codebase
// legible to both humans and coding agents: palette-only colors, <Screen>
// as every screen root, and every offline-cache-backed store fetch guarded
// by withTimeout(). See scripts/lib/consistency-checks.js for rules.

const {
  findHexViolations,
  findScreenViolations,
  findUnprotectedFetchViolations,
  findRawModalWithTextInputViolations,
} = require('./lib/consistency-checks');

const hexViolations = findHexViolations();
const screenViolations = findScreenViolations();
const unprotectedFetchViolations = findUnprotectedFetchViolations();
const rawModalWithTextInputViolations = findRawModalWithTextInputViolations();

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

if (unprotectedFetchViolations.length) {
  failed = true;
  console.error(`\n✗ Store fetch functions missing withTimeout() (${unprotectedFetchViolations.length}) — these have an isNetworkError()-gated offline cache fallback, but nothing stops the fetch from hanging instead of rejecting, so the fallback never runs and the screen is stuck loading forever:\n`);
  unprotectedFetchViolations.forEach(l => console.error(`  ${l}`));
}

if (rawModalWithTextInputViolations.length) {
  failed = true;
  console.error(`\n✗ Raw <Modal> with a <TextInput> inside it (${rawModalWithTextInputViolations.length}) — use <FormSheet> instead, which sets statusBarTranslucent/navigationBarTranslucent so the keyboard doesn't flicker on Android:\n`);
  rawModalWithTextInputViolations.forEach(l => console.error(`  ${l}`));
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log('✓ Consistency check passed (no hardcoded hex, all screens use <Screen>, all cache-backed store fetches use withTimeout, all form modals use <FormSheet>).');
