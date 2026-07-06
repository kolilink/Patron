import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/src/theme';
import { usePinGate } from '@/src/hooks/usePinGate';

export default function Index() {
  const { palette } = useTheme();
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const locked = useAuthStore(s => s.locked);
  const justAuthenticated = useAuthStore(s => s.justAuthenticated);
  const removedBusinessesOnLogin = useAuthStore(s => s.removedBusinessesOnLogin);
  // Only gate on a missing PIN right after a genuine fresh authentication —
  // an existing user's silently-restored session must never be interrupted
  // here (see justAuthenticated's doc comment in stores/auth.ts). Those users
  // are prompted for a PIN only when they try to sign out (see plus.tsx).
  const pinSet = usePinGate(justAuthenticated ? session?.user.id : undefined);

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  }

  if (locked) return <Redirect href="/(auth)/verrouille" />;
  if (!session) return <Redirect href="/(welcome)/" />;
  if (justAuthenticated && pinSet === false) return <Redirect href="/(auth)/creer-pin" />;
  if (justAuthenticated && pinSet === null) {
    return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  }
  if (!session.activeBusiness) {
    if (removedBusinessesOnLogin?.length) {
      return <Redirect href="/(app)/acces-supprime" />;
    }
    return <Redirect href="/(welcome)/" />;
  }
  return <Redirect href="/(app)/(tabs)/" />;
}
