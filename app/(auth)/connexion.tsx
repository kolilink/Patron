import { useRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Link, router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

interface LoginForm {
  email: string;
  password: string;
}

export default function ConnexionScreen() {
  const { login, loading, error, clearError } = useAuthStore();
  const { control, handleSubmit } = useForm<LoginForm>();
  const passwordRef = useRef<TextInput>(null);

  const onSubmit = async ({ email, password }: LoginForm) => {
    clearError();
    await login(email.trim().toLowerCase(), password);
    const { session } = useAuthStore.getState();
    if (session) {
      router.replace(session.activeBusiness ? '/(app)/(tabs)/' : '/(app)/onboarding');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            <Text variant="display" color="brand" style={styles.logo}>patron</Text>
            <Text variant="body" color="secondary">Gérez votre commerce facilement</Text>
          </View>

          <View style={styles.form}>
            <Text variant="h2">Connexion</Text>

            {error ? (
              <View style={styles.errorBox}>
                <Text variant="bodySmall" color="danger">{error}</Text>
              </View>
            ) : null}

            <Controller
              control={control}
              name="email"
              rules={{ required: "L'email est requis" }}
              render={({ field, fieldState }) => (
                <Input
                  label="Email"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
              )}
            />

            <Controller
              control={control}
              name="password"
              rules={{ required: 'Le mot de passe est requis' }}
              render={({ field, fieldState }) => (
                <Input
                  ref={passwordRef}
                  label="Mot de passe"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  secureTextEntry
                  returnKeyType="done"
                  onSubmitEditing={handleSubmit(onSubmit)}
                />
              )}
            />

            <Button
              label="Se connecter"
              loading={loading}
              onPress={handleSubmit(onSubmit)}
              fullWidth
            />
          </View>

          <View style={styles.footer}>
            <Text variant="body" color="secondary">Pas encore de compte ?{'  '}</Text>
            <Link href="/(auth)/inscription" asChild>
              <Text variant="labelLarge" color="brand">S'inscrire</Text>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  kav: { flex: 1 },
  content: {
    flexGrow: 1,
    padding: spacing[6],
    justifyContent: 'center',
    gap: spacing[8],
  },
  brand: { alignItems: 'center', gap: spacing[2] },
  logo: { letterSpacing: -1 },
  form: { gap: spacing[4] },
  errorBox: {
    backgroundColor: palette.dangerLight,
    borderRadius: 8,
    padding: spacing[3],
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
});
