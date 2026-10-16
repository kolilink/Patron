// Sweep 2026-10-16 (« success shown, effect missing ») : in Dépenses, approving a team expense
// checked the save result and signalled the outcome both ways, but REJECTING ignored the result
// entirely — success and failure closed the sheet identically, and a failed rejection left the
// expense « en attente » with no signal (the store error only renders in the screen's empty
// state). These contracts pin the parity: both decisions check the result, both are felt.

import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const handler = (src: string, name: string) => {
  const start = src.indexOf(`const ${name}`);
  return src.slice(start, src.indexOf('}, [', start));
};

describe('expense decision feedback parity (depenses)', () => {
  const src = read('app/(app)/depenses/index.tsx');

  it('reject checks the result and signals the outcome, exactly like approve', () => {
    const reject = handler(src, 'handleReject');
    expect(reject).toContain('const ok = await rejectExpense(e.id, userId);');
    expect(reject).toContain('if (ok) haptics.success(); else haptics.error();');
  });

  it('approve keeps its checked, signalled contract (the mirror source)', () => {
    const approve = handler(src, 'handleApprove');
    expect(approve).toContain('const ok = await approveExpense(e.id, userId);');
    expect(approve).toContain('if (ok) haptics.success(); else haptics.error();');
  });

  it('no bare decision call remains: rejectExpense is never awaited without its result', () => {
    expect(src).not.toMatch(/^\s+await rejectExpense\(/m);
  });
});
