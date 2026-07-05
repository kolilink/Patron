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
  const removedBusinessesOnLogin = useAuthStore(s => s.removedBusinessesOnLogin);
  const pinSet = usePinGate(session?.user.id);

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  }

  if (locked) return <Redirect href="/(auth)/verrouille" />;
  if (!session) return <Redirect href="/(welcome)/" />;
  if (pinSet === false) return <Redirect href="/(auth)/creer-pin" />;
  if (pinSet === null) {
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
