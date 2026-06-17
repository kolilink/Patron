import { StyleSheet, View } from 'react-native';
import { Pressable } from 'react-native';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { useMemo } from 'react';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { trackEvent } from '@/lib/analytics';

interface JoinForm {
  code: string;
}

export default function RejoindreScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { joinBusiness, loading, error, clearError } = useAuthStore();
  const { control, handleSubmit } = useForm<JoinForm>();

  const onSubmit = async ({ code }: JoinForm) => {
    clearError();
    trackEvent('business_join_started', null, useAuthStore.getState().session?.user.id ?? null);
    await joinBusiness(code);
    const state = useAuthStore.getState();
    if (!state.error) {
      const s = state.session;
      trackEvent('business_joined', s?.activeBusiness?.id ?? null, s?.user.id ?? null);
      router.replace('/(app)/(tabs)/');
    }
    // If there's an error, it shows in the errorBox below
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text variant="body" color="brand">← Retour</Text>
          </Pressable>
          <Text variant="h2">Rejoindre un commerce</Text>
          <Text variant="body" color="secondary">
            Entrez le code d'invitation partagé par votre partenaire :)
          </Text>
        </View>

        <View style={styles.form}>
          {error ? (
            <View style={styles.errorBox}>
              <Text variant="bodySmall" color="danger">{error}</Text>
            </View>
          ) : null}

          <Controller
            control={control}
            name="code"
            rules={{
              required: 'Le code est requis',
              minLength: { value: 4, message: 'Code trop court' },
            }}
            render={({ field, fieldState }) => (
              <Input
                label="Code d'invitation"
                value={field.value}
                onChangeText={v => field.onChange(v.toUpperCase())}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                placeholder="MANGO-47"
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.codeInput}
                returnKeyType="done"
                onSubmitEditing={handleSubmit(onSubmit)}
              />
            )}
          />

          <Button
            label="Rejoindre"
            loading={loading}
            onPress={handleSubmit(onSubmit)}
            fullWidth
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    content: { flex: 1, padding: spacing[6], gap: spacing[8] },
    header: { gap: spacing[2] },
    backBtn: { alignSelf: 'flex-start', marginBottom: spacing[2] },
    form: { gap: spacing[4] },
    errorBox: {
      backgroundColor: p.dangerLight,
      borderRadius: 8,
      padding: spacing[3],
    },
    codeInput: {
      fontSize: 20,
      letterSpacing: 4,
      textAlign: 'center',
      fontWeight: '700',
    },
  });
}
