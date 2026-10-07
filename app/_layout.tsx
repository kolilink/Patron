import '@/lib/startupTiming';
import { initConnectivity } from '@/lib/connectivity';
import * as Sentry from '@sentry/react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
// Inter — scoped to Alpha's chat bubbles only (app/(app)/alpha/index.tsx), not
// the app-wide typography tokens. Already an existing dependency (previously
// unused) so this adds no new package.json entry.
import {
  Inter_400Regular,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { PostHogProvider } from 'posthog-react-native';
import { useAuthStore } from '@/stores/auth';
import { getKV, openDb } from '@/lib/db';
import { capturePendingInviterId } from '@/lib/inviteLink';
import { setEnabled, HAPTICS_KV_KEY } from '@/lib/haptics';
import { ThemeProvider } from '@/src/theme';
import { ConfirmSheetHost } from '@/src/components/ui/ConfirmSheet';
import { ThemedStack, ThemedRootView } from '@/src/components/ui/ThemedStack';
import { posthog } from '@/lib/posthog';
import { identifyUser, resetAnalytics, trackEvent, analyticsIsTest, loadDeviceTestFlag } from '@/lib/analytics';
import { recordInstallIfFirstOpen, recordFunnelStep, flushFunnelOutbox } from '@/lib/funnel';
import { configurePurchases } from '@/lib/purchases';
import { withStartupTiming, reportFirstScreenRender, reportFirstInteraction } from '@/lib/startupTiming';
import { scheduleSplashCeiling, startupReady } from '@/src/utils/startupGate';

// Only active when EXPO_PUBLIC_SENTRY_DSN is set (no-op in local dev without it)
if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    tracesSampleRate: 0.2,
  });
}

// Only active once EXPO_PUBLIC_REVENUECAT_API_KEY_IOS/_ANDROID are set — see
// lib/purchases.ts. No-op in the meantime so the app runs fine before the
// RevenueCat/App Store Connect/Play Console setup exists.
configurePurchases();

SplashScreen.preventAutoHideAsync();

// Stable reference — Ionicons.font is a getter that creates a new object on every
// access, which breaks React 18's useSyncExternalStore snapshot check in useFonts.
const ALL_FONTS = {
  ...Ionicons.font,
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
  Inter_400Regular,
  Inter_700Bold,
};

// Start reading connectivity at module load, in parallel with fonts, so the
// answer is ready before the first screen paints (see lib/connectivity.ts).
void initConnectivity();

function RootLayout() {
  const initialize = useAuthStore(s => s.initialize);
  const session = useAuthStore(s => s.session);
  // fontError is NOT discarded: a failing font must be identified (Sentry below)
  // and must never hold the app hostage (see src/utils/startupGate.ts).
  const [fontsLoaded, fontError] = useFonts(ALL_FONTS);
  const [ceilingElapsed, setCeilingElapsed] = useState(false);
  // Route TEMPLATE ("/(app)/clients/[name]"), never the concrete path or
  // its params — those carry a client's name, a phone, ids (spec §0: zero
  // PII in events). useSegments() returns the template segments.
  const segments = useSegments();
  const screenName = '/' + segments.join('/');
  const previousScreen = useRef<string | undefined>(undefined);

  // Manual screen tracking for Expo Router
  useEffect(() => {
    if (previousScreen.current !== screenName) {
      posthog.screen(screenName, {
        previous_screen: previousScreen.current ?? null,
      });
      if (previousScreen.current === undefined) {
        reportFirstScreenRender();
      }
      previousScreen.current = screenName;
    }
  }, [screenName]);

  // Keep Sentry + PostHog user context in sync with the active session.
  // Sentry.* calls are guarded by the same DSN check as Sentry.init() above —
  // calling into the native Sentry SDK when it was never initialized is the
  // same class of risk as the RevenueCat/expo-notifications native calls
  // removed elsewhere during the 2026-07-17 logout-crash investigation (see
  // CLAUDE.md): a native module call with no guarantee it's safe to invoke
  // pre-init, un-catchable by JS try/catch if it throws.
  useEffect(() => {
    if (session) {
      if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
        Sentry.setUser({ id: session.user.id });
        Sentry.setTag('business_id', session.activeBusiness?.id ?? 'none');
        Sentry.setTag('role', session.activeMembership?.role ?? 'none');
      }
      identifyUser(session);
      // Server funnel log: a team/test session marks this device test (the
      // server ignores it for a device already linked to a real merchant).
      if (analyticsIsTest()) void recordFunnelStep('seen');
    } else {
      if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
        Sentry.setUser(null);
      }
      resetAnalytics();
    }
  }, [session]);

  // Hard ceiling, deliberately NOT gated on fonts (or auth, or db): whatever
  // never settles, the splash is dismissed after SPLASH_CEILING_MS. hideAsync is
  // idempotent, so this is harmless when the normal path already hid it.
  useEffect(() => scheduleSplashCeiling({
    hide: () => { SplashScreen.hideAsync().catch(() => { /* already hidden */ }); },
    onElapsed: () => setCeilingElapsed(true),
    setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
    clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  }), []);

  // Identify the failing font on this Samsung. Guarded by the same DSN check as
  // Sentry.init() above — never call into an uninitialised native SDK.
  useEffect(() => {
    if (fontError && process.env.EXPO_PUBLIC_SENTRY_DSN) {
      Sentry.captureException(fontError, { tags: { area: 'fonts' } });
    }
  }, [fontError]);

  const ready = startupReady(fontsLoaded, fontError, ceilingElapsed);

  useEffect(() => {
    if (!ready) return;
    // Hard ceiling so a stuck init can never pin the splash forever; the
    // normal path hides it only after the first screen has painted (below).
    const timeout = setTimeout(() => SplashScreen.hideAsync(), 2000);
    // Connectivity first: awaited (capped at ~1.2s) alongside init so the app
    // already knows if it is offline before the first screen paints.
    Promise.all([
      withStartupTiming('connectivity', initConnectivity()),
      withStartupTiming('auth_check', initialize()),
      withStartupTiming('db_open', openDb()),
    ]).then(() => {
      // Best-effort: capture a deferred invite token (install referrer /
      // clipboard) now that the KV store is open. Never blocks startup —
      // a missing token just means a normal sign-up, never a dead end.
      return capturePendingInviterId();
    }).then(async () => {
      // Haptics master switch — hydrate the persisted preference once the KV
      // store is open. Default ON: only an explicit stored 'false' silences.
      await getKV(HAPTICS_KV_KEY).then(v => setEnabled(v !== 'false')).catch(() => { });
      // Measurement (docs/measurement.md): first-open install record, the
      // cold-start app_opened, and a retry of any funnel steps still queued.
      await loadDeviceTestFlag();
      await recordInstallIfFirstOpen();
      trackEvent('app_opened', null, null, { source: 'cold_start' });
      void flushFunnelOutbox();
    }).catch(() => {
      /* non-fatal */
    }).finally(() => {
      clearTimeout(timeout);
      // Hold the splash until the first screen has actually painted — two
      // animation frames after init resolves lets the router commit and the
      // native view draw, so there's no unbranded flash between the splash
      // fade and first paint.
      requestAnimationFrame(() => requestAnimationFrame(() => SplashScreen.hideAsync()));
      // A real cold start — one half of PaymentReminderAsker's "fresh
      // session" trigger condition (the other half is a 10+min-backgrounded
      // return, bumped from app/(app)/_layout.tsx's own AppState handler).
      useAuthStore.setState(s => ({ freshSessionToken: s.freshSessionToken + 1 }));
    });
  }, [ready]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Observes the first touch anywhere in the app (capture phase, returns
          false) purely to time it — never claims the responder, so it can't
          change what actually handles the tap. See reportFirstInteraction. */}
      <ThemeProvider>
      <ThemedRootView
        onStartShouldSetResponderCapture={() => {
          reportFirstInteraction();
          return false;
        }}
      >
        <PostHogProvider client={posthog} autocapture>
          {/* No transition between top-level groups: a fade/slide here races the hero
              Modal's native presentation after "Ouvrir mon commerce" (blank frame). */}
          <ThemedStack screenOptions={{ headerShown: false, animation: 'none' }} />
          <ConfirmSheetHost root />
        </PostHogProvider>
      </ThemedRootView>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
