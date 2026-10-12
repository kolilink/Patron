import { Redirect } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { ThemedFill } from '@/src/components/ui/ThemedStack';

export default function Index() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const locked = useAuthStore(s => s.locked);
  const removedBusinessesOnLogin = useAuthStore(s => s.removedBusinessesOnLogin);

  if (loading) {
    return <ThemedFill />;
  }

  if (locked) return <Redirect href="/(auth)/verrouille" />;
  if (!session) return <Redirect href="/(welcome)/" />;
  if (!session.activeBusiness) {
    if (removedBusinessesOnLogin?.length) {
      return <Redirect href="/(app)/acces-supprime" />;
    }
    return <Redirect href="/(welcome)/" />;
  }
  return <Redirect href="/(app)/(tabs)/" />;
}
