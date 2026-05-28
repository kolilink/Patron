import { useEffect } from 'react';
import { router } from 'expo-router';
import { useAuthStore } from '@/stores/auth';

export default function OnboardingIndex() {
  const session = useAuthStore(s => s.session);

  useEffect(() => {
    if (session?.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else {
      router.replace('/(welcome)/');
    }
  }, []);

  return null;
}
