import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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

  const logout = useAuthStore(s => s.logout);
  const [bizName, setBizName] = useState(business?.name ?? '');
  const [currency, setCurrency] = useState(business?.currency ?? 'GNF');
  const [saving, setSaving] = useState(false);

  const [userName, setUserName] = useState(session?.user.name ?? '');
  const [savingUser, setSavingUser] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);

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

            const remaining = (session?.memberships ?? []).filter(m => m.id !== memId);

            if (remaining.length > 0) {
              // Switch to the first remaining business and stay in the app
              const first = remaining[0];
              useAuthStore.setState(state => {
                if (!state.session) return state;
                return {
                  session: {
                    ...state.session,
                    memberships: remaining,
                    activeBusiness: (first.business as Business) ?? null,
                    activeMembership: first,
                  },
                };
              });
              router.replace('/(app)/(tabs)/');
            } else {
              // No more businesses — go straight to welcome
              useAuthStore.setState(state => {
                if (!state.session) return state;
                return {
                  session: {
                    ...state.session,
                    memberships: [],
                    activeBusiness: null,
                    activeMembership: null,
                  },
                };
              });
              router.replace('/(welcome)/');
            }
          },
        },
      ],
    );
  };

  const handleDeleteAccount = async () => {
    if (deleteInput !== 'SUPPRIMER') return;
    setDeleting(true);

    // Check: admin of a business with other active members → block
    const memberships = session?.memberships ?? [];
    const adminBusinessIds = memberships
      .filter(m => m.role === 'administrateur')
      .map(m => m.business_id);

    if (adminBusinessIds.length > 0) {
      const { data: otherMembers } = await supabase
        .from('memberships')
        .select('business_id')
        .in('business_id', adminBusinessIds)
        .neq('user_id', userId);

      if (otherMembers && otherMembers.length > 0) {
        setDeleting(false);
        setShowDeleteConfirm(false);
        setDeleteInput('');
        Alert.alert(
          'Suppression impossible',
          "Vous êtes administrateur d'un commerce avec des membres actifs.\n\nRetirez tous les membres ou transférez votre rôle avant de supprimer votre compte.",
        );
        return;
      }
    }

    const { error } = await supabase.rpc('delete_my_account');
    if (error) {
      setDeleting(false);
      Alert.alert('Erreur', "La suppression a échoué. Contactez le support si le problème persiste.");
      return;
    }

    // RPC succeeded — sign out locally (auth session is now invalid)
    await useAuthStore.getState().logout();
  };

  const openPrivacy = () => Linking.openURL('https://patron.kolilink.com/privacy.html');
  const openSupport = () => Linking.openURL('https://wa.me/12672421843');

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
                      style={[styles.chip, currency === c ? styles.chipActive : styles.chipGhost]}
                    >
                      <Text
                        variant="label"
                        style={{ color: currency === c ? palette.textInverse : palette.textDisabled }}
                      >
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

          {/* Zone rouge */}
          <Card style={[styles.section, styles.dangerCard]}>
            <Text variant="label" color="secondary">Zone rouge</Text>

            {!isAdmin && (
              <>
                <Text variant="bodySmall" color="secondary">
                  Quitter ce commerce supprime votre accès. Un administrateur peut vous réinviter.
                </Text>
                <Pressable onPress={handleLeave} style={styles.dangerBtn}>
                  <Text variant="label" style={{ color: palette.danger }}>Quitter ce commerce</Text>
                </Pressable>
              </>
            )}

            {!showDeleteConfirm ? (
              <Pressable onPress={() => { setShowDeleteConfirm(true); setDeleteInput(''); }} style={styles.dangerBtn}>
                <Text variant="label" style={{ color: palette.danger }}>Supprimer mon compte</Text>
              </Pressable>
            ) : (
              <View style={styles.deleteConfirmBox}>
                <Text variant="label" style={{ color: palette.danger }}>Supprimer définitivement ?</Text>
                <Text variant="bodySmall" color="secondary">
                  {isAdmin
                    ? "Votre compte et votre commerce (produits, ventes, dépenses) seront définitivement supprimés."
                    : "Votre compte sera supprimé. Les ventes que vous avez enregistrées restent dans le commerce."}
                  {'\n\n'}Tapez SUPPRIMER pour confirmer.
                </Text>
                <TextInput
                  style={styles.deleteInput}
                  value={deleteInput}
                  onChangeText={setDeleteInput}
                  placeholder="SUPPRIMER"
                  placeholderTextColor={palette.textDisabled}
                  autoCapitalize="characters"
                />
                <View style={{ flexDirection: 'row', gap: spacing[3] }}>
                  <Pressable
                    onPress={() => { setShowDeleteConfirm(false); setDeleteInput(''); }}
                    style={[styles.dangerBtn, { flex: 1, alignItems: 'center' }]}
                  >
                    <Text variant="label" color="secondary">Annuler</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleDeleteAccount}
                    disabled={deleteInput !== 'SUPPRIMER' || deleting}
                    style={[styles.dangerBtn, { flex: 1, alignItems: 'center',
                      opacity: deleteInput !== 'SUPPRIMER' || deleting ? 0.4 : 1 }]}
                  >
                    <Text variant="label" style={{ color: palette.danger }}>
                      {deleting ? 'Suppression…' : 'Confirmer'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </Card>

          {/* À propos */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">À propos</Text>
            <Pressable onPress={openPrivacy} style={styles.linkRow}>
              <Text variant="body">Politique de confidentialité</Text>
              <Text variant="caption" color="secondary">›</Text>
            </Pressable>
            <Pressable onPress={openSupport} style={styles.linkRow}>
              <Text variant="body">Contacter le support (WhatsApp)</Text>
              <Text variant="caption" color="secondary">›</Text>
            </Pressable>
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
  chipGhost: { borderColor: 'transparent', backgroundColor: 'transparent' },
  dangerCard: { borderColor: palette.danger + '40', borderWidth: 1 },
  dangerBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1.5,
    borderColor: palette.danger + '50',
    borderRadius: radius.full,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[2],
    backgroundColor: palette.danger + '0D',
  },
  deleteConfirmBox: { gap: spacing[3] },
  deleteInput: {
    borderWidth: 1.5,
    borderColor: palette.danger + '60',
    borderRadius: radius.md,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    color: palette.danger,
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 2,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing[2],
  },
});
