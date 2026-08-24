import PostHog from 'posthog-react-native';
import type { CaptureEvent } from '@posthog/core';
import { APP_STATE_FLAP_GUARD_MS } from './sync';

// Android's AppState bridge can flap 'active'/'background' dozens of times a
// second with nobody touching the phone (see APP_STATE_FLAP_GUARD_MS's own
// doc comment in lib/sync.ts, and __tests__/app-state-flap-guard.test.ts —
// confirmed live via real PostHog session data, 07-27/07-28). That fix
// debounces the app's own reaction to the flapping, but posthog-react-native's
// captureAppLifecycleEvents autocapture (on by default) has its own separate
// AppState listener with no debounce option of its own — it kept sending an
// "Application Backgrounded"/"Application Became Active" event per raw flap
// regardless, hundreds/hour on affected devices, so the analytics data itself
// was never actually fixed by the app-side change. Disabling
// captureAppLifecycleEvents outright would also drop Application
// Installed/Updated/Opened, which aren't part of the bug, so instead only
// these two flap-prone event names are rate-limited here, via before_send,
// reusing the same guard window already validated for the in-app reaction.
const FLAP_PRONE_EVENTS = new Set(['Application Backgrounded', 'Application Became Active']);
const lastFlapEventAt = new Map<string, number>();

function dropAppStateFlapDuplicates(event: CaptureEvent | null): CaptureEvent | null {
  if (!event || !FLAP_PRONE_EVENTS.has(event.event)) return event;
  const now = Date.now();
  const last = lastFlapEventAt.get(event.event) ?? 0;
  if (now - last < APP_STATE_FLAP_GUARD_MS) return null;
  lastFlapEventAt.set(event.event, now);
  return event;
}

// Singleton — imported by lib/analytics.ts and by app/_layout.tsx (for PostHogProvider).
// The API key is optional in dev; events are silently dropped when the key is absent.
export const posthog = new PostHog(
  process.env.EXPO_PUBLIC_POSTHOG_KEY ?? '',
  {
    host: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    disabled: !process.env.EXPO_PUBLIC_POSTHOG_KEY,
    sendFeatureFlagEvent: false,
    before_send: dropAppStateFlapDuplicates,
  },
);
