'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Screens that render no visual content (redirect-only or a bare loading
// passthrough) and therefore have no safe-area surface — legitimately exempt
// from the <Screen> requirement. Keep this list explicit rather than
// pattern-matched so a genuine violation can never silently slip through it.
const SCREEN_EXEMPT = new Set([
  'app/index.tsx',
  'app/(app)/guest-account.tsx',
  'app/(app)/onboarding/index.tsx',
  'app/(app)/(tabs)/caisse.tsx',
]);

function grepFiles(pattern, dirs) {
  try {
    return execSync(
      `grep -rn '${pattern}' ${dirs.join(' ')}` +
      ` --include="*.tsx" --include="*.ts"` +
      ` --exclude-dir=node_modules`,
      { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }
    ).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Rule: no hardcoded hex colors outside src/theme/ — screens and stores must
// go through useTheme()'s palette tokens so light/dark and future rebrand
// stay centralised.
function findHexViolations() {
  return grepFiles('#[0-9A-Fa-f]\\{3,8\\}', ['app', 'src', 'stores', 'lib'])
    .filter(l => !l.startsWith('src/theme/'));
}

// Rule: every screen under app/ (except _layout.tsx, which is a navigator
// not a screen) must use <Screen> as its root instead of a raw
// <SafeAreaView> — Screen handles the correct edges + palette background
// automatically. SafeAreaView is still fine *inside* a <Modal>.
//
// Detection is import-based (does the file import and render <Screen>
// anywhere) rather than "is SafeAreaView on a line containing Modal" — the
// latter was the previous heuristic in this file and produced false
// positives on every single legitimate Modal-nested SafeAreaView, because
// the <Modal> tag is virtually always a few lines above, not on the same
// line as <SafeAreaView>.
function findScreenViolations() {
  const files = execSync(`find app -name "*.tsx" -not -name "_layout.tsx"`, {
    cwd: ROOT,
    encoding: 'utf-8',
  }).trim().split('\n').filter(Boolean);

  const violations = [];
  for (const rel of files) {
    if (SCREEN_EXEMPT.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const importsScreen = /from ['"]@\/src\/components\/ui(\/Screen)?['"]/.test(src);
    const rendersScreen = /<Screen[\s>]/.test(src);
    if (!importsScreen || !rendersScreen) violations.push(rel);
  }
  return violations;
}

module.exports = { findHexViolations, findScreenViolations, SCREEN_EXEMPT };
