// Permanent guard for the failure vocabulary (src/utils/failure.ts):
//  1. No Alert.alert('Erreur', …) — "Erreur" is never a headline.
//  2. No raw err.message shown to her: a `.message` may not flow directly into
//     a user-facing sink (toast, Alert, failAlert, set…Error, JSX text, a store's
//     `error:`) or serve as the fallback of translateError/friendlyMessage.
//     Server-authored sentences go through serverSentence()/failureReason().
//  3. Every try/catch in app/ is classified with a `// failure: speaks | silent |
//     control-flow — reason` marker inside its block (the audit, kept honest).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['app', 'src', 'stores', 'lib'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const ERREUR_ALERT = /Alert\s*\.\s*alert\s*\(\s*['"`]Erreur['"`]/;

const RAW_MESSAGE_SINKS: RegExp[] = [
  /(toast\.\w+|Alert\s*\.\s*alert|failAlert|showFailureAlert)\s*\([^;]*?\b\w*(err|error|e|Err)\w*\.message\b/,
  /\bset[A-Za-z]*(Error|Message|Msg)\s*\([^;]*?\b\w*(err|error|e|Err)\w*\.message\b/,
  /(?<!\$)\{\s*\w*(err|error|e|Err)\w*\??\.message\s*\}/,
  /(translateError|friendlyMessage)\s*\([^;]*?,\s*[^;]*?\.message\s*\)/,
  /\berror\s*:\s*(\w+\s+instanceof\s+Error\s*\?\s*)?\w*(err|error|e|Err)\w*\.message\b/,
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// The two-statement shape that hid in discussions.tsx: a variable named like a
// message, filled from err.message, then handed to a setter. UI layers only
// (stores keep a raw copy to pattern-match server sentences — see PR notes).
const MESSAGE_VAR = /\bconst\s+(msg|message|errMsg|errorMessage|text)\s*=\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/;

export function findRawMessageVariables(src: string): string[] {
  const hits: string[] = [];
  stripComments(src).split('\n').forEach((line, i) => { if (MESSAGE_VAR.test(line)) hits.push(`${i + 1}: ${line.trim()}`); });
  return hits;
}

export function findRawMessageUses(src: string): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  code.split('\n').forEach((line, i) => {
    if (RAW_MESSAGE_SINKS.some(re => re.test(line))) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

export function findErreurAlerts(src: string): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  code.split('\n').forEach((line, i) => { if (ERREUR_ALERT.test(line)) hits.push(`${i + 1}: ${line.trim()}`); });
  // multi-line form: Alert.alert(\n  'Erreur', …
  if (/Alert\s*\.\s*alert\s*\(\s*\n\s*['"`]Erreur['"`]/.test(code)) hits.push('multi-line Alert.alert(Erreur)');
  return hits;
}

const CLASS_OK = /\/\/ failure: (speaks|silent|control-flow) — \S/;

export function catchBlocksWithoutClassification(src: string): number[] {
  const bad: number[] = [];
  const re = /\}\s*catch\b\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1; let k = m.index + m[0].length;
    while (depth && k < src.length) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
    const body = src.slice(m.index + m[0].length, k - 1);
    if (!CLASS_OK.test(body)) bad.push(src.slice(0, m.index).split('\n').length);
  }
  return bad;
}

describe('failure guard — detectors work', () => {
  it('catches Alert.alert("Erreur", …) in every quote style and layout', () => {
    expect(findErreurAlerts("Alert.alert('Erreur', 'x');")).toHaveLength(1);
    expect(findErreurAlerts('Alert.alert("Erreur", x);')).toHaveLength(1);
    expect(findErreurAlerts('Alert.alert(\n  `Erreur`, x);')).toHaveLength(1);
    expect(findErreurAlerts("Alert.alert('Produit non enregistré', x);")).toHaveLength(0);
    expect(findErreurAlerts("// Alert.alert('Erreur', x)")).toHaveLength(0);
  });
  it('catches a raw message flowing straight to the user', () => {
    for (const bad of [
      "toast.warning(err.message);",
      "Alert.alert('Oups', error.message);",
      "setPostError(e.message);",
      "setAddPartnerError(err instanceof Error ? err.message : 'x');",
      "<Text>{err.message}</Text>",
      "const t = translateError(err, err.message);",
      "set({ error: err.message });",
      "failAlert('x', { why: error.message });",
    ]) expect(findRawMessageUses(bad)).toHaveLength(1);
  });
  it('does not flag sanctioned flows', () => {
    for (const ok of [
      "toast.warning(translateError(err, 'x'));",
      "failAlert('x', { why: serverSentence(error) });",
      "const raw = err instanceof Error ? err.message : String(err);",
      "console.error('[x]', err.message);",
      "setPostError(friendlyMessage(err, FAILURE_COPY.postNotPublished.what));",
    ]) expect(findRawMessageUses(ok)).toHaveLength(0);
  });
  it("catches the discussions.tsx shape (message variable filled from err.message)", () => {
    expect(findRawMessageVariables("const msg = err instanceof Error ? err.message : 'x';")).toHaveLength(1);
    expect(findRawMessageVariables("const raw = err instanceof Error ? err.message : String(err);")).toHaveLength(0);
  });
  it('an unclassified try/catch is flagged', () => {
    expect(catchBlocksWithoutClassification('try { a(); } catch { b(); }')).toHaveLength(1);
    expect(catchBlocksWithoutClassification('try { a(); } catch (e) {\n // failure: silent — best effort\n }')).toHaveLength(0);
    expect(catchBlocksWithoutClassification('try { a(); } catch {\n // failure: oops\n }')).toHaveLength(1);
  });
});

describe('failure guard — the repo', () => {
  const files = SCAN.flatMap(d => walk(path.join(ROOT, d)));
  const rel = (f: string) => path.relative(ROOT, f);

  it('no Alert.alert("Erreur", …) anywhere', () => {
    const offenders = files.flatMap(f => findErreurAlerts(fs.readFileSync(f, 'utf8')).map(h => `${rel(f)}:${h}`));
    expect(offenders).toEqual([]);
  });

  it('no raw err.message reaches the user without a translation helper', () => {
    const offenders = files.flatMap(f => findRawMessageUses(fs.readFileSync(f, 'utf8')).map(h => `${rel(f)}:${h}`));
    expect(offenders).toEqual([]);
  });

  it('no UI layer builds a user-facing message variable from err.message', () => {
    const offenders = files
      .filter(f => rel(f).startsWith('app' + path.sep) || rel(f).startsWith('src' + path.sep))
      .flatMap(f => findRawMessageVariables(fs.readFileSync(f, 'utf8')).map(h => `${rel(f)}:${h}`));
    expect(offenders).toEqual([]);
  });

  it('every try/catch in app/ is classified (speaks / silent / control-flow) with a reason', () => {
    const offenders = files
      .filter(f => rel(f).startsWith('app' + path.sep))
      .flatMap(f => catchBlocksWithoutClassification(fs.readFileSync(f, 'utf8')).map(l => `${rel(f)}:${l}`));
    expect(offenders).toEqual([]);
  });

  it('a "speaks" catch never shows a raw message', () => {
    const offenders: string[] = [];
    for (const f of files.filter(f => rel(f).startsWith('app' + path.sep))) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /\}\s*catch\b\s*(\([^)]*\))?\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        let depth = 1; let k = m.index + m[0].length;
        while (depth && k < src.length) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
        const body = src.slice(m.index + m[0].length, k - 1);
        if (/\/\/ failure: speaks/.test(body) && /\.message\b/.test(stripComments(body))) offenders.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
