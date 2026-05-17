import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { palette, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

interface CreateForm {
  name: string;
  type: string;
}

const CURRENCIES = ['GNF', 'XOF'];
const TYPES = ['Commerce général', 'Restaurant', 'Pharmacie', 'Artisanat', 'Services', 'Autre'];

export default function CreerCommerceScreen() {
  const { createBusiness, loading, error, clearError } = useAuthStore();
  const { control, handleSubmit } = useForm<CreateForm>();
  const [currency, setCurrency] = useState('GNF');
  const [businessType, setBusinessType] = useState('');

  const onSubmit = async ({ name }: CreateForm) => {
    clearError();
    await createBusiness({ name: name.trim(), type: businessType || undefined, currency });
    const { session } = useAuthStore.getState();
    if (session?.activeBusiness) {
      router.replace('/(app)/(tabs)/');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Text variant="body" color="brand">← Retour</Text>
            </Pressable>
            <Text variant="h2">Créer un commerce</Text>
            <Text variant="body" color="secondary">
              Vous deviendrez automatiquement l'Administrateur.
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
              name="name"
              rules={{ required: 'Le nom du commerce est requis', minLength: { value: 2, message: 'Minimum 2 caractères' } }}
              render={({ field, fieldState }) => (
                <Input
                  label="Nom du commerce"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={fieldState.error?.message}
                  placeholder="Ex: Boutique Mamadou"
                  autoCapitalize="words"
                  returnKeyType="next"
                />
              )}
            />

            <View style={styles.section}>
              <Text variant="label" style={styles.sectionLabel}>Type de commerce (optionnel)</Text>
              <View style={styles.chips}>
                {TYPES.map(t => (
                  <Pressable
                    key={t}
                    style={[styles.chip, businessType === t && styles.chipActive]}
                    onPress={() => setBusinessType(prev => prev === t ? '' : t)}
                  >
                    <Text
                      variant="labelSmall"
                      color={businessType === t ? 'inverse' : 'secondary'}
                    >
                      {t}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <Text variant="label" style={styles.sectionLabel}>Devise</Text>
              <View style={styles.chips}>
                {CURRENCIES.map(c => (
                  <Pressable
                    key={c}
                    style={[styles.chip, currency === c && styles.chipActive]}
                    onPress={() => setCurrency(c)}
                  >
                    <Text
                      variant="labelSmall"
                      color={currency === c ? 'inverse' : 'secondary'}
                    >
                      {c}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Button
              label="Créer le commerce"
              loading={loading}
              onPress={handleSubmit(onSubmit)}
              fullWidth
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  kav: { flex: 1 },
  content: { flexGrow: 1, padding: spacing[6], gap: spacing[8] },
  header: { gap: spacing[2] },
  backBtn: { alignSelf: 'flex-start', marginBottom: spacing[2] },
  form: { gap: spacing[5] },
  errorBox: {
    backgroundColor: palette.dangerLight,
    borderRadius: 8,
    padding: spacing[3],
  },
  section: { gap: spacing[2] },
  sectionLabel: { color: palette.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1.5],
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  chipActive: {
    backgroundColor: palette.primary,
    borderColor: palette.primary,
  },
});
