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

interface RegisterForm {
  name: string;
  email: string;
  password: string;
  confirm: string;
}

export default function InscriptionScreen() {
  const { register: registerUser, loading, error, clearError } = useAuthStore();
  const { control, handleSubmit, watch } = useForm<RegisterForm>();
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const password = watch('password');

  const onSubmit = async ({ name, email, password }: RegisterForm) => {
    clearError();
    await registerUser(name.trim(), email.trim().toLowerCase(), password);
    const { session } = useAuthStore.getState();
    if (session) {
      router.replace('/(app)/onboarding');
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
          <View style={styles.header}>
            <Text variant="display" color="brand" style={styles.logo}>patron</Text>
            <Text variant="h3">Créer un compte</Text>
          </View>

          <View style={styles.form}>
            {error ? (
              <View style={[
                styles.msgBox,
                error.startsWith('Un email') ? styles.msgInfo : styles.msgError,
              ]}>
                <Text
                  variant="bodySmall"
                  color={error.startsWith('Un email') ? 'success' : 'danger'}
                >
                  {error}
                </Text>
              </View>
            ) : null}

            <Controller
              control={control}
              name="name"
              rules={{ required: 'Le nom est requis', minLength: { value: 2, message: 'Minimum 2 caractères' } }}
              render={({ field, fieldState }) => (
                <Input
                  label="Nom complet"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  autoComplete="name"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                />
              )}
            />

            <Controller
              control={control}
              name="email"
              rules={{ required: "L'email est requis" }}
              render={({ field, fieldState }) => (
                <Input
                  ref={emailRef}
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
              rules={{
                required: 'Le mot de passe est requis',
                minLength: { value: 8, message: 'Minimum 8 caractères' },
              }}
              render={({ field, fieldState }) => (
                <Input
                  ref={passwordRef}
                  label="Mot de passe"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  secureTextEntry
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef.current?.focus()}
                />
              )}
            />

            <Controller
              control={control}
              name="confirm"
              rules={{
                required: 'Confirmez le mot de passe',
                validate: v => v === password || 'Les mots de passe ne correspondent pas',
              }}
              render={({ field, fieldState }) => (
                <Input
                  ref={confirmRef}
                  label="Confirmer le mot de passe"
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
              label="Créer mon compte"
              loading={loading}
              onPress={handleSubmit(onSubmit)}
              fullWidth
            />
          </View>

          <View style={styles.footer}>
            <Text variant="body" color="secondary">Déjà un compte ?{'  '}</Text>
            <Link href="/(auth)/connexion" asChild>
              <Text variant="labelLarge" color="brand">Se connecter</Text>
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
    gap: spacing[6],
  },
  header: { alignItems: 'center', gap: spacing[2] },
  logo: { letterSpacing: -1 },
  form: { gap: spacing[4] },
  msgBox: { borderRadius: 8, padding: spacing[3] },
  msgError: { backgroundColor: palette.dangerLight },
  msgInfo: { backgroundColor: palette.successLight },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
});
