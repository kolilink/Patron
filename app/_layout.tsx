import '@/lib/startupTiming';
import * as Sentry from '@sentry/react-native';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, usePathname, useGlobalSearchParams } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import { PostHogProvider } from 'posthog-react-native';
import { useAuthStore } from '@/stores/auth';
import { openDb } from '@/lib/db';
import { ThemeProvider } from '@/src/theme';
import { posthog } from '@/lib/posthog';
import { identifyUser, resetAnalytics } from '@/lib/analytics';
import { configurePurchases } from '@/lib/purchases';
import { withStartupTiming, reportFirstScreenRender, reportFirstInteraction } from '@/lib/startupTiming';

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
};

function RootLayout() {
  const initialize = useAuthStore(s => s.initialize);
  const session = useAuthStore(s => s.session);
  const [fontsLoaded] = useFonts(ALL_FONTS);
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const previousPathname = useRef<string | undefined>(undefined);

  // Manual screen tracking for Expo Router
  useEffect(() => {
    if (previousPathname.current !== pathname) {
      posthog.screen(pathname, {
        previous_screen: previousPathname.current ?? null,
        ...params,
      });
      if (previousPathname.current === undefined) {
        reportFirstScreenRender();
      }
      previousPathname.current = pathname;
    }
  }, [pathname, params]);

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
    } else {
      if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
        Sentry.setUser(null);
      }
      resetAnalytics();
    }
  }, [session]);

  useEffect(() => {
    if (!fontsLoaded) return;
    const timeout = setTimeout(() => SplashScreen.hideAsync(), 2000);
    Promise.all([
      withStartupTiming('auth_check', initialize()),
      withStartupTiming('db_open', openDb()),
    ]).finally(() => {
      clearTimeout(timeout);
      SplashScreen.hideAsync();
    });
  }, [fontsLoaded]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Observes the first touch anywhere in the app (capture phase, returns
          false) purely to time it — never claims the responder, so it can't
          change what actually handles the tap. See reportFirstInteraction. */}
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponderCapture={() => {
          reportFirstInteraction();
          return false;
        }}
      >
        <PostHogProvider client={posthog} autocapture>
          <ThemeProvider>
            <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
          </ThemeProvider>
        </PostHogProvider>
      </View>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
