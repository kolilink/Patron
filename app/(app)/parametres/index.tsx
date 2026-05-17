import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';

const CURRENCIES = ['GNF', 'XOF', 'USD', 'EUR'];

export default function ParametresScreen() {
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';

  const [bizName, setBizName] = useState(business?.name ?? '');
  const [currency, setCurrency] = useState(business?.currency ?? 'GNF');
  const [saving, setSaving] = useState(false);

  const [userName, setUserName] = useState(session?.user.name ?? '');
  const [savingUser, setSavingUser] = useState(false);

  const saveBusiness = async () => {
    if (!bizName.trim()) { Alert.alert('Nom requis'); return; }
    setSaving(true);
    const { error } = await supabase
      .from('businesses')
      .update({ name: bizName.trim(), currency })
      .eq('id', business?.id ?? '');
    setSaving(false);
    if (error) { Alert.alert('Erreur', error.message); return; }
    Alert.alert('✅', 'Commerce mis à jour. Reconnectez-vous pour voir les changements.');
  };

  const saveUser = async () => {
    if (!userName.trim()) { Alert.alert('Nom requis'); return; }
    setSavingUser(true);
    const { error } = await supabase
      .from('profiles')
      .update({ name: userName.trim() })
      .eq('id', userId);
    setSavingUser(false);
    if (error) Alert.alert('Erreur', error.message);
    else Alert.alert('✅', 'Profil mis à jour.');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Paramètres</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {/* Business settings */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">Commerce</Text>
            <Input label="Nom du commerce" value={bizName} onChangeText={setBizName} placeholder="Nom…" />
            <View>
              <Text variant="label" style={styles.fieldLabel}>Devise</Text>
              <View style={styles.chipRow}>
                {CURRENCIES.map(c => (
                  <Pressable key={c} onPress={() => setCurrency(c)}
                    style={[styles.chip, currency === c && styles.chipActive]}>
                    <Text variant="label" style={{ color: currency === c ? palette.textInverse : palette.textPrimary }}>{c}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <Button label={saving ? 'Enregistrement…' : 'Sauvegarder le commerce'}
              loading={saving} onPress={saveBusiness} />
          </Card>

          {/* User profile */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">Mon profil</Text>
            <Input label="Nom affiché" value={userName} onChangeText={setUserName} placeholder="Votre nom…" />
            <Button label={savingUser ? '…' : 'Sauvegarder le profil'}
              loading={savingUser} onPress={saveUser} variant="outline" />
          </Card>

          {/* Danger zone */}
          <Card style={[styles.section, styles.dangerCard]}>
            <Text variant="label" color="danger">Zone de danger</Text>
            <Text variant="bodySmall" color="secondary">
              Ces actions sont irréversibles. Procédez avec précaution.
            </Text>
            <Button
              label="Quitter ce commerce"
              variant="danger"
              onPress={() => Alert.alert(
                'Quitter ' + business?.name + ' ?',
                'Vous perdrez l\'accès à ce commerce. Un Admin peut vous réinviter.',
                [
                  { text: 'Annuler', style: 'cancel' },
                  {
                    text: 'Quitter', style: 'destructive',
                    onPress: async () => {
                      const memId = session?.activeMembership?.id;
                      if (!memId) return;
                      await supabase.from('memberships').delete().eq('id', memId);
                      router.replace('/(app)/onboarding');
                    },
                  },
                ],
              )}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  section: { gap: spacing[4] },
  fieldLabel: { marginBottom: spacing[2] },
  chipRow: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
  chip: { paddingHorizontal: spacing[4], paddingVertical: spacing[2], borderRadius: radius.full, borderWidth: 1.5, borderColor: palette.border, backgroundColor: palette.surface },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  dangerCard: { borderColor: palette.danger + '40' },
});
