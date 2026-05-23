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
import type { Business } from '@/src/types';

const CURRENCIES = ['GNF', 'XOF', 'USD', 'EUR'];

export default function ParametresScreen() {
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const role = session?.activeMembership?.role;
  const isAdmin = role === 'administrateur';

  const [bizName, setBizName] = useState(business?.name ?? '');
  const [currency, setCurrency] = useState(business?.currency ?? 'GNF');
  const [saving, setSaving] = useState(false);

  const [userName, setUserName] = useState(session?.user.name ?? '');
  const [savingUser, setSavingUser] = useState(false);

  const saveBusiness = async () => {
    const trimmed = bizName.trim();
    if (!trimmed) { Alert.alert('Nom requis'); return; }
    setSaving(true);
    const { error } = await supabase
      .from('businesses')
      .update({ name: trimmed, currency })
      .eq('id', business?.id ?? '');
    setSaving(false);
    if (error) { Alert.alert('Erreur', error.message); return; }

    // Patch the Zustand session so the rest of the app sees the new name/currency immediately.
    useAuthStore.setState(state => {
      if (!state.session?.activeBusiness) return state;
      const updated: Business = { ...state.session.activeBusiness, name: trimmed, currency };
      return {
        session: {
          ...state.session,
          activeBusiness: updated,
          memberships: state.session.memberships.map(m =>
            m.business_id === business?.id ? { ...m, business: updated } : m,
          ),
        },
      };
    });

    Alert.alert('Commerce mis à jour', `"${trimmed}" est maintenant actif.`);
  };

  const saveUser = async () => {
    const trimmed = userName.trim();
    if (!trimmed) { Alert.alert('Nom requis'); return; }
    setSavingUser(true);
    const { error } = await supabase
      .from('profiles')
      .update({ name: trimmed })
      .eq('id', userId);
    setSavingUser(false);
    if (error) { Alert.alert('Erreur', error.message); return; }

    // Patch the session so the Plus screen header reflects the new name instantly.
    useAuthStore.setState(state => {
      if (!state.session) return state;
      return { session: { ...state.session, user: { ...state.session.user, name: trimmed } } };
    });

    Alert.alert('Profil mis à jour', `Votre nom est maintenant "${trimmed}".`);
  };

  const handleLeave = () => {
    Alert.alert(
      `Quitter ${business?.name ?? 'ce commerce'} ?`,
      "Vous perdrez l'accès à ce commerce. Un administrateur peut vous réinviter.",
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Quitter', style: 'destructive',
          onPress: async () => {
            const memId = session?.activeMembership?.id;
            if (!memId) return;
            const { error } = await supabase.from('memberships').delete().eq('id', memId);
            if (error) { Alert.alert('Erreur', error.message); return; }
            router.replace('/(app)/onboarding');
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">Paramètres</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {/* Business settings — admin only */}
          {isAdmin && (
            <Card style={styles.section}>
              <Text variant="label" color="secondary">Commerce</Text>
              <Input
                label="Nom du commerce"
                value={bizName}
                onChangeText={setBizName}
                placeholder="Nom de votre commerce…"
                returnKeyType="done"
              />
              <View style={{ gap: spacing[2] }}>
                <Text variant="label">Devise</Text>
                <View style={styles.chipRow}>
                  {CURRENCIES.map(c => (
                    <Pressable
                      key={c}
                      onPress={() => setCurrency(c)}
                      style={[styles.chip, currency === c && styles.chipActive]}
                    >
                      <Text variant="label" style={{ color: currency === c ? palette.textInverse : palette.textPrimary }}>
                        {c}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <Button
                label={saving ? 'Enregistrement…' : 'Sauvegarder le commerce'}
                loading={saving}
                onPress={saveBusiness}
                fullWidth
              />
            </Card>
          )}

          {/* User profile — all roles */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">Mon profil</Text>
            <Input
              label="Nom affiché"
              value={userName}
              onChangeText={setUserName}
              placeholder="Votre nom…"
              returnKeyType="done"
            />
            <Button
              label={savingUser ? 'Enregistrement…' : 'Sauvegarder le profil'}
              loading={savingUser}
              onPress={saveUser}
              variant="outline"
              fullWidth
            />
          </Card>

          {/* Danger zone */}
          <Card style={[styles.section, styles.dangerCard]}>
            <Text variant="label" color="danger">Zone de danger</Text>
            <Text variant="bodySmall" color="secondary">
              Ces actions sont irréversibles. Procédez avec précaution.
            </Text>
            <Button label="Quitter ce commerce" variant="danger" onPress={handleLeave} fullWidth />
          </Card>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  section: { gap: spacing[4] },
  chipRow: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[2],
    borderRadius: radius.full, borderWidth: 1.5, borderColor: palette.border, backgroundColor: palette.surface,
  },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  dangerCard: { borderColor: palette.danger + '40', borderWidth: 1 },
});
