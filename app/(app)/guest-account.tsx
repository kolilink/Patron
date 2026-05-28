import { useEffect } from 'react';
import { router } from 'expo-router';

// Guest mode has been removed. This screen is no longer reachable.
// Redirect to the home tab if somehow navigated here.
export default function GuestAccountScreen() {
  useEffect(() => {
    router.replace('/(app)/(tabs)/');
  }, []);
  return null;
}
