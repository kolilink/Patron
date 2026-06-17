import { useEffect } from 'react';
import { router } from 'expo-router';
import { useAuthStore } from '@/stores/auth';

export default function OnboardingIndex() {
  const session = useAuthStore(s => s.session);

  useEffect(() => {
    if (session?.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else if (session) {
      // Logged in but no business yet — go to the create flow.
      // Never redirect back to (welcome) here: the welcome screen redirects
      // to onboarding when it sees a session, which would create an infinite loop.
      router.replace('/(app)/onboarding/creer');
    } else {
      router.replace('/(welcome)/');
    }
  }, []);

  return null;
}
