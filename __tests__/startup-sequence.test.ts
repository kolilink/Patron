// openDb() (SQLite.openDatabaseAsync + migrations) can hang forever without resolving OR
// rejecting. The launch effect awaited it unbounded, so the whole post-startup chain
// (invite capture, install record, app_opened, funnel flush) and the .finally never ran.
// See src/utils/startupGate.ts (runStartupSequence).
import fs from 'fs';
import path from 'path';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ encrypt: jest.fn(async (s: string) => s), decrypt: jest.fn(async (s: string) => s) }));

import * as SQLite from 'expo-sqlite';
import { openDb, resetDbPromise } from '@/lib/db';
import { STARTUP_STAGE_TIMEOUT_MS, TIMED_OUT, raceStartup, runStartupSequence } from '@/src/utils/startupGate';

const never = () => new Promise<never>(() => { /* never settles */ });

function makeDeps(over: Partial<Parameters<typeof runStartupSequence>[0]> = {}) {
  const order: string[] = [];
  const deps = {
    initialize: jest.fn(async () => { order.push('initialize'); }),
    openDb: jest.fn(async () => { order.push('openDb'); }),
    resetDb: jest.fn(() => { order.push('resetDb'); }),
    reportTimeout: jest.fn((stage: string) => { order.push(`timeout:${stage}`); }),
    postOpenSteps: jest.fn(async () => { order.push('postOpen'); }),
    onDone: jest.fn(() => { order.push('done'); }),
    ...over,
  };
  return { deps, order };
}

describe('runStartupSequence', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('with openDb mocked to a never-settling promise, the post-startup chain still runs within the timeout', async () => {
    const { deps, order } = makeDeps({ openDb: jest.fn(never) });
    const p = runStartupSequence(deps);
    await jest.advanceTimersByTimeAsync(STARTUP_STAGE_TIMEOUT_MS - 1);
    expect(deps.postOpenSteps).not.toHaveBeenCalled();           // still waiting at 7.999 s
    await jest.advanceTimersByTimeAsync(1);                       // the 8 s timeout fires
    await p;
    expect(deps.reportTimeout).toHaveBeenCalledWith('db_open');   // reported to Sentry
    expect(deps.resetDb).toHaveBeenCalledTimes(1);                // cached promise reset → a later openDb() retries
    expect(deps.postOpenSteps).toHaveBeenCalledTimes(1);          // invite capture / install record / app_opened / funnel flush
    expect(deps.onDone).toHaveBeenCalledTimes(1);                 // splash hide + freshSessionToken bump
    expect(order).toEqual(['initialize', 'timeout:db_open', 'resetDb', 'postOpen', 'done']);
  });

  it('the healthy path is unchanged: no timeout, no reset, in order', async () => {
    const { deps, order } = makeDeps();
    await runStartupSequence(deps);
    expect(order).toEqual(['initialize', 'openDb', 'postOpen', 'done']);
    expect(deps.reportTimeout).not.toHaveBeenCalled();
    expect(deps.resetDb).not.toHaveBeenCalled();
  });

  it('the KV-dependent steps are bounded too — a second hang cannot keep onDone from running', async () => {
    const { deps } = makeDeps({ openDb: jest.fn(never), postOpenSteps: jest.fn(never) });
    const p = runStartupSequence(deps);
    await jest.advanceTimersByTimeAsync(STARTUP_STAGE_TIMEOUT_MS * 2);
    await p;
    expect(deps.reportTimeout).toHaveBeenCalledWith('db_open');
    expect(deps.reportTimeout).toHaveBeenCalledWith('post_open');
    expect(deps.onDone).toHaveBeenCalledTimes(1);
  });

  it('a REJECTING stage is still non-fatal: postOpen is skipped (as before) but onDone runs', async () => {
    const { deps } = makeDeps({ openDb: jest.fn(async () => { throw new Error('corrupt'); }) });
    await runStartupSequence(deps);
    expect(deps.postOpenSteps).not.toHaveBeenCalled();
    expect(deps.onDone).toHaveBeenCalledTimes(1);
    expect(deps.reportTimeout).not.toHaveBeenCalled();
  });

  it('raceStartup: a late settle after the timeout is harmless (no unhandled rejection)', async () => {
    let rejectLate!: (e: Error) => void;
    const late = new Promise<never>((_, rej) => { rejectLate = rej; });
    const onTimeout = jest.fn();
    const p = raceStartup(late, 100, onTimeout);
    await jest.advanceTimersByTimeAsync(100);
    expect(await p).toBe(TIMED_OUT);
    rejectLate(new Error('too late'));
    await jest.advanceTimersByTimeAsync(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('resetDbPromise (lib/db.ts) — the retry after a hung open', () => {
  const open = SQLite.openDatabaseAsync as jest.Mock;
  const fakeDb = { execAsync: jest.fn(async () => {}), runAsync: jest.fn(async () => {}), getFirstAsync: jest.fn(async () => ({ version: 999 })), getAllAsync: jest.fn(async () => []) };

  it('a hung open is handed to every caller until reset; after reset the next openDb() opens fresh', async () => {
    open.mockReset();
    open.mockImplementationOnce(never);       // the hung native open
    open.mockImplementationOnce(async () => fakeDb);
    void openDb();
    void openDb();
    expect(open).toHaveBeenCalledTimes(1);    // cached: one hung open shared by all callers
    resetDbPromise();
    await expect(openDb()).resolves.toBe(fakeDb);
    expect(open).toHaveBeenCalledTimes(2);    // a fresh open
  });
});

describe('app/_layout.tsx wiring', () => {
  const layout = fs.readFileSync(path.resolve(__dirname, '../app/_layout.tsx'), 'utf8');
  it('runs the sequence through runStartupSequence with resetDbPromise and a DSN-guarded Sentry report', () => {
    expect(layout).toMatch(/void runStartupSequence\(\{/);
    expect(layout).toMatch(/resetDb: resetDbPromise,/);
    expect(layout).toMatch(/if \(process\.env\.EXPO_PUBLIC_SENTRY_DSN\) \{\s*Sentry\.captureMessage\(`startup_\$\{stage\}_timeout`/);
    expect(layout).not.toMatch(/Promise\.all\(\[\s*withStartupTiming\('auth_check'/);
  });
  it('the steps that moved are all still there, in order', () => {
    const order = ['capturePendingInviterId()', 'getKV(HAPTICS_KV_KEY)', 'loadDeviceTestFlag()', 'recordInstallIfFirstOpen()', "trackEvent('app_opened'", 'flushFunnelOutbox()', 'freshSessionToken: s.freshSessionToken + 1'];
    let at = -1;
    for (const needle of order) { const i = layout.indexOf(needle, at + 1); expect(i).toBeGreaterThan(at); at = i; }
  });
});
