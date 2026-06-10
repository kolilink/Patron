import { useEffect, useRef } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth';
import { openDb } from '@/lib/db';

SplashScreen.preventAutoHideAsync();

// Stable reference — Ionicons.font is a getter that creates a new object on every
// access, which breaks React 18's useSyncExternalStore snapshot check in useFonts.
const IONICONS_FONT = Ionicons.font;

export default function RootLayout() {
  const initialize = useAuthStore(s => s.initialize);
  const [fontsLoaded] = useFonts(IONICONS_FONT);

  useEffect(() => {
    if (!fontsLoaded) return;
    const timeout = setTimeout(() => SplashScreen.hideAsync(), 5000);
    Promise.all([initialize(), openDb()]).finally(() => {
      clearTimeout(timeout);
      SplashScreen.hideAsync();
    });
  }, [fontsLoaded]);

  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
  );
}
