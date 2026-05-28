import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { palette } from '@/src/theme';

export default function Index() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const removedBusinessesOnLogin = useAuthStore(s => s.removedBusinessesOnLogin);

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  }

  if (!session) return <Redirect href="/(welcome)/" />;
  if (!session.activeBusiness) {
    if (removedBusinessesOnLogin?.length) {
      return <Redirect href="/(app)/acces-supprime" />;
    }
    return <Redirect href="/(welcome)/" />;
  }
  return <Redirect href="/(app)/(tabs)/" />;
}
