import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getKV, setKV } from '@/lib/db';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { generateId } from '@/lib/id';
import { trackEvent, analyticsIsTest } from '@/lib/analytics';

// Server-side record of the two funnel steps the business tables can't see:
// install and OTP (migration_v209's funnel_devices / record_funnel_step()).
// The founder KPI screen reads these from Supabase — never from PostHog —
// so they're queued on the device and retried until they land, exactly
// like the PostHog SDK's own offline queue but against our own table.
//
// No PII: a random per-install device id, a step name, a timestamp.

export type FunnelStep = 'installed' | 'otp_sent' | 'otp_verified' | 'seen';

type PendingStep = { step: FunnelStep; at: string };

const DEVICE_ID_KEY = 'analytics_device_id';
const INSTALLED_AT_KEY = 'analytics_installed_at';
const OUTBOX_KEY = 'funnel_outbox';
const MAX_OUTBOX = 50;

let flushing = false;

async function getDeviceId(): Promise<string> {
  const existing = await getKV(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = generateId();
  await setKV(DEVICE_ID_KEY, id);
  return id;
}

async function readOutbox(): Promise<PendingStep[]> {
  try {
    const raw = await getKV(OUTBOX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeOutbox(items: PendingStep[]): Promise<void> {
  await setKV(OUTBOX_KEY, JSON.stringify(items.slice(-MAX_OUTBOX)));
}

/** Queue one step and try to send it now. Never throws. */
export async function recordFunnelStep(step: FunnelStep): Promise<void> {
  try {
    const items = await readOutbox();
    items.push({ step, at: new Date().toISOString() });
    await writeOutbox(items);
  } catch {
    return;
  }
  void flushFunnelOutbox();
}

/**
 * First open of this install: fires app_installed once, ever, and queues the
 * server-side 'installed' step. Call after openDb() — the KV store must be
 * open.
 */
export async function recordInstallIfFirstOpen(): Promise<void> {
  try {
    if (await getKV(INSTALLED_AT_KEY)) return;
    await setKV(INSTALLED_AT_KEY, new Date().toISOString());
    trackEvent('app_installed', null, null, { platform: Platform.OS });
    await recordFunnelStep('installed');
  } catch {
    // Silently drop — analytics must never affect merchant experience
  }
}

/** Sends queued steps in order. Stops at the first network error, keeps the rest. */
export async function flushFunnelOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let items = await readOutbox();
    if (items.length === 0) return;
    const deviceId = await getDeviceId();
    while (items.length > 0) {
      const next = items[0];
      try {
        const { error } = await withTimeout(supabase.rpc('record_funnel_step', {
          p_device_id: deviceId,
          p_step: next.step,
          p_at: next.at,
          p_platform: Platform.OS,
          p_is_test: analyticsIsTest(),
        }));
        // A network failure keeps the step for the next flush. Any other
        // error (invalid step, server rejection) can never succeed on
        // retry, so it's dropped rather than blocking the queue forever.
        if (error && isNetworkError(error)) break;
      } catch (err) {
        if (isNetworkError(err)) break;
      }
      items = items.slice(1);
      await writeOutbox(items);
    }
  } catch {
    // Silently drop
  } finally {
    flushing = false;
  }
}
