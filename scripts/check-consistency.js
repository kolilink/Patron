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
  findFunctionExposureViolations,
  findResurrectedForkViolations,
  findHeroModalFadeViolations,
  findSystemAlertViolations,
  findSkeletonOutsideDataStateViolations,
} = require('./lib/consistency-checks');

const hexViolations = findHexViolations();
const screenViolations = findScreenViolations();
const unprotectedFetchViolations = findUnprotectedFetchViolations();
const rawModalWithTextInputViolations = findRawModalWithTextInputViolations();
const functionExposureViolations = findFunctionExposureViolations();

const resurrectedForkViolations = findResurrectedForkViolations();
const heroModalFadeViolations = findHeroModalFadeViolations();
const systemAlertViolations = findSystemAlertViolations();
const skeletonViolations = findSkeletonOutsideDataStateViolations();

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

if (functionExposureViolations.length) {
  failed = true;
  console.error(`\n✗ Database functions callable by anon with no auth check (${functionExposureViolations.length}) — every function under db/ must REVOKE EXECUTE from anon (naming anon explicitly: REVOKE ... FROM PUBLIC alone does not remove anon's direct grant) or contain an auth check (auth.uid / is_member / get_role / is_founder). See scripts/lib/function-exposure.js:\n`);
  functionExposureViolations.forEach(l => console.error(`  ${l}`));
}

if (resurrectedForkViolations.length) {
  failed = true;
  console.error(`\n✗ no-resurrected-fork (${resurrectedForkViolations.length}) — ActivationForkOverlay was deleted on purpose (killed 2026-09-27, regressed 2026-10-06). FirstRunHeroOverlay is the only first-run surface; do not bring the fork back:\n`);
  resurrectedForkViolations.forEach(l => console.error(`  ${l}`));
}

if (heroModalFadeViolations.length) {
  failed = true;
  console.error(`\n✗ hero-modal-no-fade — the first-run hero Modal must be animationType="none" or a blank/skeleton frame shows between "Ouvrir mon commerce" and the hero:\n`);
  heroModalFadeViolations.forEach(l => console.error(`  ${l}`));
}

if (systemAlertViolations.length) {
  failed = true;
  console.error(`\n✗ no-system-alert (${systemAlertViolations.length}) — Alert.alert is the OS dialog (white Material dialog on Android). Use appAlert() from src/utils/appAlert.ts (same arguments) so the app's own ConfirmSheet shows on both platforms:\n`);
  systemAlertViolations.forEach(l => console.error(`  ${l}`));
}

if (skeletonViolations.length) {
  failed = true;
  console.error(`\n✗ data-state-invariant (${skeletonViolations.length}) — a Skeleton* component may only render as the skeleton={…} slot of <DataState> (src/components/ui/DataState.tsx). Hand-rolled loading gates replay the skeleton for loaded-but-empty lists. Drive it from the store's fetchStatus (lib/fetchStatus.ts):\n`);
  skeletonViolations.forEach(l => console.error(`  ${l}`));
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log('✓ Consistency check passed (no hardcoded hex, all screens use <Screen>, all cache-backed store fetches use withTimeout, all form modals use <FormSheet>, no db/ function is anon-callable without an auth check).');
