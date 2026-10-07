import { ThemedStack } from '@/src/components/ui/ThemedStack';

export default function AuthLayout() {
  return (
    <ThemedStack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />
  );
}
