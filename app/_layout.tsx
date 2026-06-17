import * as Sentry from '@sentry/react-native';
import { useEffect, useRef } from 'react';
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

// Only active when EXPO_PUBLIC_SENTRY_DSN is set (no-op in local dev without it)
if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    tracesSampleRate: 0.2,
  });
}

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
      previousPathname.current = pathname;
    }
  }, [pathname, params]);

  // Keep Sentry + PostHog user context in sync with the active session.
  useEffect(() => {
    if (session) {
      Sentry.setUser({ id: session.user.id });
      Sentry.setTag('business_id', session.activeBusiness?.id ?? 'none');
      Sentry.setTag('role', session.activeMembership?.role ?? 'none');
      identifyUser(session);
    } else {
      Sentry.setUser(null);
      resetAnalytics();
    }
  }, [session]);

  useEffect(() => {
    if (!fontsLoaded) return;
    const timeout = setTimeout(() => SplashScreen.hideAsync(), 5000);
    Promise.all([initialize(), openDb()]).finally(() => {
      clearTimeout(timeout);
      SplashScreen.hideAsync();
    });
  }, [fontsLoaded]);

  return (
    <PostHogProvider client={posthog} autocapture>
      <ThemeProvider>
        <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
      </ThemeProvider>
    </PostHogProvider>
  );
}

export default Sentry.wrap(RootLayout);
