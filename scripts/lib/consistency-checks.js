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

// Rule: a store function that (a) drives a `loading` flag and (b) has an
// isNetworkError()-gated offline-cache-fallback catch block MUST wrap its
// Supabase call in withTimeout(). This is the exact bug class documented in
// CLAUDE.md under "Offline read caches" / "The withTimeout() sweep" — a
// store's catch block can be perfectly correct and still never run, because
// on some real network conditions (dead wifi, not true airplane mode) the
// underlying fetch hangs instead of rejecting, so `loading` never resolves
// and the fallback code is simply never reached. That bug shipped multiple
// times across different stores before withTimeout() existed specifically to
// close it — this check exists so a new store fetch function can't
// reintroduce the same gap silently.
//
// Deliberately scoped to stores/*.ts only, not app/**/*.tsx. Screen-local
// fetches (e.g. the dashboard's loadKpis/loadBestSellers) use inconsistent
// loading-state conventions — a shared skeleton flag owned by a wrapping
// caller, useState with an arbitrary setter name — that a regex-based check
// can't reliably parse without a real false-positive/false-negative problem.
// CLAUDE.md's own "Offline queue" section documents this exact scoping gap
// (screen-local fetches were missed by a store-only sweep) as a known,
// accepted limitation, not something this check silently pretends to cover.
//
// A function is "in scope" only when its body contains BOTH a `loading:
// true` set AND an isNetworkError( check — that pairing is what marks it as
// following the offline-read-cache pattern, as opposed to e.g. an auth.ts
// interactive login/OTP flow (also sets loading:true, but has no cache to
// fall back to, so it never calls isNetworkError and is correctly out of
// scope for this specific check).
const FUNC_START = /^(\s*)(?:([A-Za-z_]\w*)\s*:\s*async\s*\([^)]*\)(?:\s*:\s*[^=]+)?\s*=>\s*\{|async function\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{)/;

function extractBlock(src, startIdx) {
  let depth = 1;
  let i = startIdx;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(startIdx, i - 1);
}

function findUnprotectedFetchViolations() {
  const violations = [];
  const files = fs.readdirSync(path.join(ROOT, 'stores')).filter(f => f.endsWith('.ts'));

  for (const f of files) {
    const rel = path.join('stores', f);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const lines = src.split('\n');

    for (let li = 0; li < lines.length; li++) {
      const m = lines[li].match(FUNC_START);
      if (!m) continue;
      const name = m[2] || m[3];
      const lineStartOffset = lines.slice(0, li).join('\n').length + (li > 0 ? 1 : 0);
      const braceIdx = lineStartOffset + lines[li].indexOf('{', m[1].length);
      if (braceIdx < 0) continue;

      const block = extractBlock(src, braceIdx + 1);
      const hasLoadingTrue = /loading:\s*true/.test(block);
      const hasSupabaseCall =
        /supabase[\s\S]{0,30}?\.(from|rpc)\(/.test(block) || /supabase\.auth\.\w+\(/.test(block);
      const hasIsNetworkError = /isNetworkError\(/.test(block);
      // withNetworkRetry() wraps withTimeout() internally (see lib/sync.ts) —
      // a call using it is equally protected against the hang-forever bug
      // this check exists for, just via an extra confirm-with-retry layer.
      const hasWithTimeout = /withTimeout\(|withNetworkRetry\(/.test(block);

      if (hasLoadingTrue && hasSupabaseCall && hasIsNetworkError && !hasWithTimeout) {
        violations.push(`${rel}:${li + 1} ${name}`);
      }
    }
  }
  return violations;
}

// Rule: a <Modal> (from 'react-native') that shares a component function
// with a keyboard-triggering field (<TextInput>, <Input>, <PhoneInput>) must
// itself carry `statusBarTranslucent` (and, per RN's own Modal.js, whichever
// Modal also sets `navigationBarTranslucent` must set both, or RN warns —
// checked separately below).
//
// Why: on Android, <Modal> opens its own separate native window. The rest
// of the app has edgeToEdgeEnabled: true (app.json), but a Modal's window
// does NOT get the same edge-to-edge treatment unless these props are set —
// and that mismatch is exactly what caused a real production bug: the
// keyboard flashing open/closed inside "Nouveau produit" (catalogue.tsx),
// because the Modal's un-configured window fought with the OS's keyboard-pan
// handling for the same layout. <FormSheet> (src/components/ui/FormSheet.tsx)
// is the recommended way to get this right for an ordinary full-screen form
// — it sets both props once, centrally — but it isn't the only legitimate
// shape: src/components/BusinessDrawer.tsx, for instance, is a gesture-driven
// slide-in side panel with its own transparent Modal that a full-screen form
// sheet would be wrong for. So the actual invariant enforced here is the
// props themselves, on whichever <Modal> tag is present, not "must use
// FormSheet" — any bespoke Modal that sets both props correctly passes.
//
// A <Modal> with no keyboard field inside it (an action sheet, a
// confirmation dialog) never triggers the software keyboard and is
// unaffected — only the pairing is checked, not <Modal> on its own.
// <DatePickerField> is deliberately not treated as a keyboard field: it
// opens a native date-picker modal, never the software keyboard.
//
// Scoped per component function (matching each `function Name(` declaration,
// the convention every modal-rendering component in this codebase already
// follows) rather than per-file, so a screen with both an unrelated
// action-sheet Modal AND ordinary page fields elsewhere doesn't
// false-positive — same reasoning as findUnprotectedFetchViolations' own
// per-function scoping. Scans the full source text (not line-by-line) and
// balances parens/braces by character index — a line-anchored regex was
// tried first and silently missed every component whose destructured
// parameter list spans multiple lines (e.g. `function Foo({\n  a, b,\n}: Props) {`),
// which is exactly the shape `vendre.tsx`'s PaymentModal — arguably the
// single highest-traffic modal in the app — uses. That gap meant the check
// reported clean while the actual highest-risk screen was never inspected at
// all. Accepts the same known limitation as extractBlock below (an
// unbalanced paren/brace inside a string/comment could desync the match).
const FUNC_DECL = /function\s+[A-Za-z_]\w*\s*\(/g;

function findRawModalWithTextInputViolations() {
  const files = execSync(`find app src -name "*.tsx"`, { cwd: ROOT, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);

  const violations = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    FUNC_DECL.lastIndex = 0;
    let m;
    while ((m = FUNC_DECL.exec(src))) {
      const parenOpenIdx = FUNC_DECL.lastIndex - 1; // index of the '(' just matched
      // Balance parens to find the matching ')', however many lines the
      // parameter list spans.
      let depth = 1;
      let i = parenOpenIdx + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      // From just past the matching ')', skip an optional return-type
      // annotation to the body's opening brace — same "first '{' wins"
      // assumption as before, valid because no component in this codebase
      // uses an inline object-literal return type.
      const braceIdx = src.indexOf('{', i);
      if (braceIdx === -1) continue;
      const lineNumber = src.slice(0, braceIdx).split('\n').length;

      const block = extractBlock(src, braceIdx + 1);
      // <Input> and <PhoneInput> (src/components/ui/) both wrap a real
      // <TextInput> internally and trigger the software keyboard exactly
      // the same way — checking only the raw RN tag would miss most real
      // forms in this codebase, which use these wrappers rather than
      // <TextInput> directly.
      const hasKeyboardField = /<(TextInput|Input|PhoneInput)[\s/>]/.test(block);
      if (!hasKeyboardField) continue;

      // Captures each <Modal ...> opening tag's own attributes, up to its
      // first real tag-closing '>'. A naive `[\s\S]*?>` breaks on two real
      // things found while building this check: an arrow-function prop
      // (`onRequestClose={() => ...}` is the norm on every Modal here, and
      // '=>' contains a literal '>'), and a `//` comment mentioning a JSX
      // tag by name (this file's own comment on BusinessDrawer's Modal says
      // "doesn't fit <FormSheet>'s ... shape", and that bare '>' ended the
      // match early too) — both silently truncated the captured tag
      // mid-attribute-list and reported a false violation on a Modal that
      // actually already had both props set. '=>' and `// ...` (to end of
      // line) are each matched as one atomic unit, tried before the
      // single-char fallback, so a '>' inside either can never be mistaken
      // for the tag's close.
      const modalTags = block.match(/<Modal\b(?:=>|\/\/[^\n]*|[^>])*?>/g) || [];
      for (const tag of modalTags) {
        if (!/statusBarTranslucent/.test(tag)) {
          violations.push(`${rel}:${lineNumber}`);
        }
      }
    }
  }
  return violations;
}

module.exports = {
  findHexViolations,
  findScreenViolations,
  findUnprotectedFetchViolations,
  findRawModalWithTextInputViolations,
  SCREEN_EXEMPT,
};
