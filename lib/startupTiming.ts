import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { trackEvent } from '@/lib/analytics';

// Captured at module-evaluation time. app/_layout.tsx imports this file
// before anything else runs, so this is as close to "app launched" as JS
// can observe — good enough as a shared origin for the step timings below,
// even though it's not the literal native process-start instant.
const appLaunchedAt = Date.now();

let firstScreenReported = false;

function deviceContext() {
  return {
    platform: Platform.OS,
    os_version: Device.osVersion,
    device_model: Device.modelName,
    // expo-device reports bytes; PostHog segmentation is easier in whole MB.
    total_memory_mb:
      Device.totalMemory != null ? Math.round(Device.totalMemory / (1024 * 1024)) : null,
  };
}

// One shared event shape for every startup step, so they're all queryable
// together in PostHog and can be segmented by device RAM/model, not just OS
// version — see CLAUDE.md's "Android Cold-Start Regression" memory for why
// that segmentation matters more than the platform-version aggregate did.
function reportStep(step: string, durationMs: number): void {
  trackEvent('startup_step_completed', null, null, {
    step,
    duration_ms: durationMs,
    ...deviceContext(),
  });
}

// Wraps a startup promise purely to time it — never changes what it resolves
// to or whether/how it rejects, so wrapping initialize()/openDb() with this
// cannot change app behavior, only add a telemetry side-channel.
export function withStartupTiming<T>(step: string, promise: Promise<T>): Promise<T> {
  const startedAt = Date.now();
  return promise.finally(() => reportStep(step, Date.now() - startedAt));
}

// Call once, the first time real screen content is about to render. Reports
// elapsed time since this module was first evaluated — the same "app open"
// origin every other step timing here uses, so this number is directly
// comparable to the existing PostHog cold-start report (app open -> first
// screen rendered), while the auth_check/db_open events explain what's
// inside it.
export function reportFirstScreenRender(): void {
  if (firstScreenReported) return;
  firstScreenReported = true;
  reportStep('first_screen_render', Date.now() - appLaunchedAt);
}
