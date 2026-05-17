import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { palette } from '@/src/theme';

export default function Index() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  }

  if (!session) return <Redirect href="/(auth)/connexion" />;
  if (!session.activeBusiness) return <Redirect href="/(app)/onboarding" />;
  return <Redirect href="/(app)/(tabs)/" />;
}
