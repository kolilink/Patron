import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useAuthStore } from '@/stores/auth';
import { openDb } from '@/lib/db';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const initialize = useAuthStore(s => s.initialize);

  useEffect(() => {
    const timeout = setTimeout(() => SplashScreen.hideAsync(), 5000);
    Promise.all([initialize(), openDb()]).finally(() => {
      clearTimeout(timeout);
      SplashScreen.hideAsync();
    });
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
  );
}
