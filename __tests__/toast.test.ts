// The one toast: a floating pill that stacks, auto-dismisses, can be swiped away, and carries a real undo.
import fs from 'fs';
import path from 'path';
import { useToastStore, toast, TOAST_DURATION_MS, TOAST_ACTION_WINDOW_MS, TOAST_EXIT_MS, MAX_VISIBLE_TOASTS } from '@/stores/toast';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const st = () => useToastStore.getState();

beforeEach(() => { jest.useFakeTimers(); st().clear(); });
afterEach(() => { st().clear(); jest.useRealTimers(); });

describe('appears and auto-dismisses', () => {
  it('a toast appears at once and is gone after ~4s', () => {
    toast.success('Enregistré — vente de 2 000 GNF.');
    expect(st().toasts.map(t => t.message)).toEqual(['Enregistré — vente de 2 000 GNF.']);
    jest.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(st().toasts).toHaveLength(1);
    expect(st().toasts[0].exiting).toBe(false);
    jest.advanceTimersByTime(2);
    expect(st().toasts).toHaveLength(1); // the clock starts the exit; the pill fades, it does not pop
    expect(st().toasts[0].exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
  });
  it('swipe-up dismiss (dismiss(id)) starts its exit early and cancels its timer', () => {
    const id = toast.info('x');
    st().dismiss(id);
    expect(st().toasts).toHaveLength(1);
    expect(st().toasts[0].exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
    toast.info('y');
    jest.advanceTimersByTime(TOAST_DURATION_MS + TOAST_EXIT_MS + 1);   // the first one's timer must not take 'y' down early or throw
    expect(st().toasts).toHaveLength(0);
  });
});

describe('a second toast never clobbers the first', () => {
  it('both are visible, in order; each leaves on its own clock', () => {
    toast.success('premier');
    jest.advanceTimersByTime(1500);
    toast.warning('second');
    expect(st().toasts.map(t => t.message)).toEqual(['premier', 'second']);
    jest.advanceTimersByTime(TOAST_DURATION_MS - 1500 + 1);
    expect(st().toasts.map(t => t.message)).toEqual(['premier', 'second']); // 'premier' is on its way out
    expect(st().toasts[0].exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts.map(t => t.message)).toEqual(['second']);
  });
  it(`at most ${MAX_VISIBLE_TOASTS} at once; the oldest plain one makes room, an undo is never dropped for a plain toast`, () => {
    const undo = jest.fn();
    toast.saved({ message: 'vente', undo });
    toast.info('a'); toast.info('b'); toast.info('c');
    const msgs = st().toasts.map(t => t.message);
    expect(msgs).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(msgs).toContain('vente');
  });
});

describe('the "Annuler" action', () => {
  it('runs the undo, then the pill goes', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const id = toast.saved({ message: 'vente', undo: run });
    expect(st().toasts[0].action?.label).toBe('Annuler');
    await st().runAction(id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(st().toasts[0].exiting).toBe(true); // the pill fades out after the undo, same exit as a timeout
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
  });
  it('stays available for ~5s, then the action is gone and the pill leaves', () => {
    const id = toast.saved({ message: 'vente', undo: jest.fn() });
    jest.advanceTimersByTime(TOAST_ACTION_WINDOW_MS - 1);
    expect(st().toasts.find(t => t.id === id)?.actionExpired).toBe(false);
    jest.advanceTimersByTime(2);
    expect(st().toasts.find(t => t.id === id)?.exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
  });
  it('a double tap runs the undo once', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const id = toast.saved({ message: 'vente', undo: run });
    await Promise.all([st().runAction(id), st().runAction(id)]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('a failing undo still clears the pill (no stuck spinner)', async () => {
    const id = toast.saved({ message: 'vente', undo: jest.fn().mockRejectedValue(new Error('boom')) });
    await expect(st().runAction(id)).rejects.toThrow('boom');
    expect(st().toasts[0].exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
  });
  it('"Modifier" follow-up replaces Annuler after the window and lives a normal display time', () => {
    const edit = jest.fn();
    const id = toast.saved({ message: 'vente', undo: jest.fn(), onEdit: edit });
    jest.advanceTimersByTime(TOAST_ACTION_WINDOW_MS + 1);
    const t = st().toasts.find(x => x.id === id)!;
    expect(t.actionExpired).toBe(true);
    expect(t.followUp?.label).toBe('Modifier');
    jest.advanceTimersByTime(TOAST_DURATION_MS + 1);
    expect(st().toasts.find(t => t.id === id)?.exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
  });
});

describe('repeats coalesce into the pill already up', () => {
  it('the same plain toast pushed twice stays one pill, and the repeat restarts its clock', () => {
    const first = toast.success('Produit ajouté');
    jest.advanceTimersByTime(3000);
    const second = toast.success('Produit ajouté');
    expect(second).toBe(first);
    expect(st().toasts).toHaveLength(1);
    expect(st().toasts[0].repeats).toBe(2);
    jest.advanceTimersByTime(1500); // past the FIRST push's deadline — still up on the restarted clock
    expect(st().toasts).toHaveLength(1);
    expect(st().toasts[0].exiting).toBe(false);
    jest.advanceTimersByTime(TOAST_DURATION_MS - 1500 + 1);
    expect(st().toasts[0].exiting).toBe(true);
    jest.advanceTimersByTime(TOAST_EXIT_MS);
    expect(st().toasts).toHaveLength(0);
  });
  it('a different message or a different tone does not coalesce', () => {
    toast.success('Produit ajouté');
    toast.success('Vente enregistrée');
    toast.warning('Produit ajouté');
    expect(st().toasts).toHaveLength(3);
  });
  it('a toast carrying "Annuler" never coalesces and is never coalesced into', () => {
    toast.saved({ message: 'vente', undo: jest.fn() });
    toast.saved({ message: 'vente', undo: jest.fn() });
    expect(st().toasts).toHaveLength(2);
    toast.success('vente'); // same words as the undo pill — still its own pill
    expect(st().toasts).toHaveLength(3);
  });
});

describe('the exit is animated, never a pop', () => {
  it('dismiss flags exiting first; removal follows after TOAST_EXIT_MS', () => {
    const id = toast.info('x');
    st().dismiss(id);
    expect(st().toasts).toHaveLength(1);
    jest.advanceTimersByTime(TOAST_EXIT_MS - 1);
    expect(st().toasts).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(st().toasts).toHaveLength(0);
  });
  it('the component drives entry and exit from the exiting flag, with a glide for the stack', () => {
    const src = read('src/components/ui/Toast.tsx');
    expect(src).toContain('TOAST_EXIT_MS');
    expect(src).toContain('exiting');
    expect(src).toContain('LayoutAnimation');
    expect(src).not.toContain('ENTER_OFFSET = -90'); // no more 90px spring drop
    expect(src).toContain('ENTER_OFFSET = -8');
  });
  it('the quick-add sheet pill crossfades on a repeat add (keyed by product name)', () => {
    expect(read('src/components/QuickAddProductSheet.tsx')).toContain('key={toastName}');
  });
});

describe('structure: one toast, no banners, no per-screen toasts', () => {
  it('the old banner components and the separate SaveConfirmation store are gone', () => {
    for (const f of ['src/components/ui/AppToast.tsx', 'src/components/ui/SaveConfirmation.tsx', 'stores/saveConfirmation.ts']) {
      expect(fs.existsSync(path.join(__dirname, '..', f))).toBe(false);
    }
    expect(read('app/(app)/_layout.tsx')).toContain('<ToastHost />');
    expect(read('app/(app)/_layout.tsx')).not.toMatch(/AppToastContainer|<SaveConfirmation/);
  });
  it('the pill is compact + translucent + swipe-up, not full width', () => {
    const src = read('src/components/ui/Toast.tsx');
    expect(src).toContain('<BlurView');
    expect(src).toContain('PanResponder');
    expect(src).toContain('alignItems: \'center\'');
    expect(src).not.toMatch(/left: spacing\[4\],\s*right: spacing\[4\],\s*flexDirection/); // the old full-width banner shape
    expect(src).toContain('borderRadius: radius.full');
  });
  it('no screen rolls its own toast', () => {
    const walk = (d: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, out); else if (/\.tsx?$/.test(e.name)) out.push(r); } return out; };
    const offenders = ['app', 'src', 'stores', 'lib'].flatMap(d => walk(d))
      .filter(f => /ui\/AppToast|useSaveConfirmationStore|stores\/saveConfirmation'|<SaveConfirmation\b|ui\/SaveConfirmation'/.test(read(f)) && !f.endsWith('saveConfirmationCopy.ts'));
    expect(offenders).toEqual([]);
  });
});
