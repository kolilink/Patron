/**
 * Discussions tab switch — contract tests.
 *
 * The bug class (2026-10-16): the tab tap was gated on an 80ms fade-out whose
 * `finished` callback performed the state switch. An interrupted fade
 * (finished=false) swallowed the tap entirely, and even on the happy path the
 * vendor waited on the machine's animation before seeing the new tab.
 *
 * The contract: the state switch is synchronous in the press handler; the
 * only animation left is the entrance fade of the NEW content.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'app', '(app)', 'discussions.tsx'), 'utf8');

describe('Discussions — tab switch is synchronous, never animation-gated', () => {
  it('handleTabChange switches immediately — no fade-out, no finished callback', () => {
    const handler = src.slice(src.indexOf('const handleTabChange'), src.indexOf('const scrollToMessage'));
    expect(handler).toContain('switchTabAndFadeIn(tab)');
    expect(handler).not.toContain('withTiming');
    expect(handler).not.toContain('finished');
  });

  it('switchTabAndFadeIn sets the active tab before any animation', () => {
    const fn = src.slice(src.indexOf('const switchTabAndFadeIn'), src.indexOf('const handleTabChange'));
    expect(fn.indexOf('setActiveTab(tab)')).toBeGreaterThanOrEqual(0);
    expect(fn.indexOf('setActiveTab(tab)')).toBeLessThan(fn.indexOf('withTiming'));
  });

  it('no 80ms fade-out gate remains anywhere in the file', () => {
    expect(src).not.toContain('duration: 80');
  });

  it('the entrance fade survives (140ms) and reduce-motion stays instant', () => {
    expect(src).toContain('duration: 140');
    expect(src).toContain('contentAlpha.value = 1');
  });
});
