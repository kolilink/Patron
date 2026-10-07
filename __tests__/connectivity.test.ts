// The single connectivity truth (lib/connectivity.ts): offline means the device
// reports NO network interface — never the third-party reachability probe.
import fs from 'fs';
import path from 'path';
import { applyNetInfoState, isKnownOffline, isNetInfoOffline, useConnectivityStore } from '@/lib/connectivity';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const reset = () => useConnectivityStore.setState({ online: true, known: false, offlineViews: 0, reconnectTick: 0 });

describe('connectivity store', () => {
  beforeEach(reset);

  it('is optimistic (never "offline") until NetInfo has answered', () => {
    expect(isKnownOffline()).toBe(false);
  });

  it('isConnected === false is offline; true / null / undefined are not', () => {
    expect(isNetInfoOffline({ isConnected: false })).toBe(true);
    expect(isNetInfoOffline({ isConnected: true })).toBe(false);
    expect(isNetInfoOffline({ isConnected: null })).toBe(false);
    expect(isNetInfoOffline(undefined)).toBe(false);
  });

  it('isInternetReachable === false alone does NOT make the app offline (blocked probe URL must not cut Supabase off)', () => {
    applyNetInfoState({ isConnected: true, isInternetReachable: false } as never);
    expect(isKnownOffline()).toBe(false);
  });

  it('airplane mode at cold start: known + offline from the first reading', () => {
    applyNetInfoState({ isConnected: false });
    expect(useConnectivityStore.getState().known).toBe(true);
    expect(isKnownOffline()).toBe(true);
  });

  it('offline → online bumps reconnectTick exactly once; the first reading never does', () => {
    applyNetInfoState({ isConnected: true });
    expect(useConnectivityStore.getState().reconnectTick).toBe(0);
    applyNetInfoState({ isConnected: false });
    applyNetInfoState({ isConnected: true });
    expect(useConnectivityStore.getState().reconnectTick).toBe(1);
    applyNetInfoState({ isConnected: true });
    expect(useConnectivityStore.getState().reconnectTick).toBe(1);
  });
});

describe('wiring (source-level — there is no JSX/native transform in this jest setup)', () => {
  it('every Supabase request is skipped while known-offline (the single choke point)', () => {
    const src = read('lib/supabase.ts');
    expect(src).toMatch(/if \(isKnownOffline\(\)\) return Promise\.reject\(new TypeError\('Network request failed'\)\)/);
  });
  it('startup reads connectivity before the first screen (module-level + awaited with init)', () => {
    const src = read('app/_layout.tsx');
    expect(src).toMatch(/void initConnectivity\(\);/);
    expect(src).toMatch(/withStartupTiming\('connectivity', initConnectivity\(\)\)/);
  });
  it('the offline notice never renders in the layout flow (headless) and the indicator is an overlay', () => {
    expect(read('src/components/ui/OfflineNotice.tsx')).toMatch(/return null;/);
    const ind = read('src/components/ui/OfflineIndicator.tsx');
    expect(ind).toMatch(/position: 'absolute'/);
    expect(ind).toMatch(/pointerEvents="none"/);
  });
  it('the quick-capture forms are keyed per opening, never on `visible` (no remount ghost on dismiss)', () => {
    const src = read('src/components/QuickCaptureSheet.tsx');
    expect(src).not.toMatch(/key=\{String\(visible\)\}/);
    expect(src).not.toMatch(/key=\{`\$\{visible\}/);
    expect(src).toMatch(/key=\{openId\}/);
  });
  it('the optional client upsert in Crédit rapide is skipped offline and capped', () => {
    const src = read('src/components/CreditRapideCapture.tsx');
    expect(src).toMatch(/!resolvedClientId && !isKnownOffline\(\)/);
    expect(src).toMatch(/CLIENT_LINK_CAP_MS/);
  });
});
