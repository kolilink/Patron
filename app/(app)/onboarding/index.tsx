import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { spacing } from '@/src/theme';

// Where a signed-in person with no business lands: right after leaving their
// last commerce, or after verifying their phone but before adding one. Same
// account, same phone — never a "new account". Two plain choices, both
// existing flows: add a commerce, or join one with an invite code.
// Never redirect back to (welcome) from here: the welcome screen redirects to
// onboarding when it sees a session, which would create an infinite loop.
export default function OnboardingIndex() {
  const session = useAuthStore(s => s.session);
  const styles = useMemo(() => makeStyles(), []);

  useEffect(() => {
    if (session?.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    } else if (!session) {
      router.replace('/(welcome)/');
    }
  }, [session]);

  // Themed blank (not null) while redirecting, so there is no white flash.
  if (!session || session.activeBusiness) return <Screen>{null}</Screen>;

  return (
    <Screen>
      <View style={styles.content}>
        <View style={styles.copy}>
          <Text variant="h2">Et maintenant ?</Text>
          <Text variant="body" color="secondary">
            Votre compte est toujours là. Ajoutez votre commerce, ou rejoignez celui d'une équipe avec un code d'invitation.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button label="Ajouter mon commerce" onPress={() => router.push('/(app)/onboarding/creer')} fullWidth size="lg" />
          <Button label="Rejoindre un commerce" variant="secondary" onPress={() => router.push('/(app)/onboarding/rejoindre')} fullWidth size="lg" />
        </View>
      </View>
    </Screen>
  );
}

function makeStyles() {
  return StyleSheet.create({
    content: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing[8], gap: spacing[8] },
    copy: { gap: spacing[3] },
    actions: { gap: spacing[3] },
  });
}
