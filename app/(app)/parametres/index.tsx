import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { generateFallbackName } from '@/lib/id';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import type { Business } from '@/src/types';

// Must match the list in creer.tsx — all currencies we support
const CURRENCIES = ['GNF', 'XOF', 'XAF', 'NGN', 'GHS', 'MAD', 'DZD', 'TND', 'EGP', 'KES', 'ZAR', 'ETB', 'AED', 'SAR', 'USD', 'EUR', 'GBP', 'CNY', 'CAD', 'CHF', 'INR'];

const CURRENCY_NAMES: Record<string, string> = {
  GNF: 'Franc Guinéen',
  XOF: 'Franc CFA (UEMOA)',
  XAF: 'Franc CFA (CEMAC)',
  NGN: 'Naira',
  GHS: 'Cedi',
  MAD: 'Dirham marocain',
  USD: 'Dollar américain',
  EUR: 'Euro',
};

export default function ParametresScreen() {
  const { palette, colorScheme, setColorScheme } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session  = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId   = session?.user.id ?? '';
  const role     = session?.activeMembership?.role;
  const isAdmin  = role === 'administrateur';

  const [bizName,  setBizName]  = useState(business?.name ?? '');
  const [currency, setCurrency] = useState(business?.currency ?? '');
  const [userName, setUserName] = useState(session?.user.name ?? '');
  const [saving,   setSaving]   = useState(false);
  const [hasSales, setHasSales] = useState<boolean | null>(null);

  // Check if any sales exist — currency locks once this is true
  useEffect(() => {
    if (!business?.id) return;
    supabase
      .from('sale_orders')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', business.id)
      .then(({ count }) => {
        const salesExist = (count ?? 0) > 0;
        setHasSales(salesExist);
        if (!salesExist) setCurrency(business.currency ?? 'GNF');
      });
  }, [business?.id]);

  const isDirty = (isAdmin
    ? (bizName.trim() !== (business?.name ?? '') || (hasSales === false && currency !== (business?.currency ?? 'GNF')))
    : false
  ) || userName.trim() !== (session?.user.name ?? '');

  const breathAnim = useRef(new Animated.Value(1)).current;
  const loopRef    = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (isDirty) {
      loopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(breathAnim, { toValue: 0.35, duration: 850, useNativeDriver: true }),
          Animated.timing(breathAnim, { toValue: 1,    duration: 850, useNativeDriver: true }),
        ]),
      );
      loopRef.current.start();
    } else {
      loopRef.current?.stop();
      loopRef.current = null;
      Animated.timing(breathAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    }
    return () => { loopRef.current?.stop(); };
  }, [isDirty]);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput,       setDeleteInput]       = useState('');
  const [deleting,          setDeleting]          = useState(false);

  const saveAll = async () => {
    const trimmedBiz  = bizName.trim();
    const trimmedUser = userName.trim();
    if (isAdmin && !trimmedBiz) { toast.warning('Donnez un nom au commerce :)'); return; }
    if (!trimmedUser) { toast.warning('Entrez votre nom :)'); return; }

    setSaving(true);

    const saveBiz = async () => {
      // Never change currency after first sale — UI + API guard
      const patch = hasSales ? { name: trimmedBiz } : { name: trimmedBiz, currency };
      const { error } = await supabase.from('businesses')
        .update(patch)
        .eq('id', business?.id ?? '');
      if (!error) {
        useAuthStore.setState(state => {
          if (!state.session?.activeBusiness) return state;
          const updated: Business = { ...state.session.activeBusiness, name: trimmedBiz, ...(hasSales ? {} : { currency }) };
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
      }
      return error;
    };

    const saveProfile = async () => {
      const { error } = await supabase.from('profiles')
        .update({ name: trimmedUser })
        .eq('id', userId);
      if (!error) {
        useAuthStore.setState(state => {
          if (!state.session) return state;
          return { session: { ...state.session, user: { ...state.session.user, name: trimmedUser } } };
        });
      }
      return error;
    };

    const errors = await Promise.all(isAdmin ? [saveBiz(), saveProfile()] : [saveProfile()]);
    setSaving(false);

    if (errors.some(Boolean)) {
      haptics.error();
      toast.warning('Pas tout enregistré. On reprend :)');
    } else {
      haptics.success();
      toast.success('Modifications enregistrées');
    }
  };

  const handleLeave = () => {
    Alert.alert(
      `Quitter ${business?.name ?? 'ce commerce'} ?`,
      "Vous perdrez l'accès à ce commerce. Un gérant peut vous réinviter.",
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Quitter', style: 'destructive',
          onPress: async () => {
            haptics.error();
            const memId = session?.activeMembership?.id;
            if (!memId) return;
            const { error } = await supabase.from('memberships').delete().eq('id', memId);
            if (error) { Alert.alert('Erreur', error.message); return; }

            const remaining = (session?.memberships ?? []).filter(m => m.id !== memId);
            if (remaining.length > 0) {
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
              useAuthStore.setState(state => {
                if (!state.session) return state;
                return { session: { ...state.session, memberships: [], activeBusiness: null, activeMembership: null } };
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
    haptics.error();
    setDeleting(true);

    const memberships    = session?.memberships ?? [];
    const adminBizIds    = memberships.filter(m => m.role === 'administrateur').map(m => m.business_id);

    if (adminBizIds.length > 0) {
      const { data: others } = await supabase
        .from('memberships').select('business_id')
        .in('business_id', adminBizIds).neq('user_id', userId);

      if (others && others.length > 0) {
        setDeleting(false);
        setShowDeleteConfirm(false);
        setDeleteInput('');
        Alert.alert(
          'Suppression impossible',
          "Vous êtes gérant d'un commerce avec des membres actifs.\n\nRetirez tous les membres avant de supprimer votre compte.",
        );
        return;
      }
    }

    const { error } = await supabase.rpc('delete_my_account');
    if (error) {
      setDeleting(false);
      toast.warning('Ça n\'a pas fonctionné. Écrivez-nous si ça continue :)');
      return;
    }
    await useAuthStore.getState().logout();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      {/* Header */}
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">Paramètres</Text>
        <Animated.View style={{ opacity: breathAnim }}>
          <Pressable onPress={saveAll} disabled={saving || !isDirty}>
            <Text variant="label" style={{ color: isDirty ? palette.primary : palette.textDisabled }}>
              {saving ? 'Enreg…' : 'Enregistrer'}
            </Text>
          </Pressable>
        </Animated.View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {/* Commerce — admin only */}
          {isAdmin && (
            <Card style={styles.section}>
              <Text variant="label" color="secondary">Commerce</Text>
              <Input
                label="Nom du commerce"
                value={bizName}
                onChangeText={setBizName}
                placeholder="Nom de votre commerce"
                returnKeyType="done"
              />
              <View style={{ gap: spacing[2] }}>
                <Text variant="label">Monnaie</Text>
                {hasSales === false ? (
                  <View style={styles.chipRow}>
                    {CURRENCIES.map(c => (
                      <Pressable
                        key={c}
                        onPress={() => setCurrency(c)}
                        style={[styles.chip, currency === c ? styles.chipActive : styles.chipGhost]}
                      >
                        <Text variant="label" style={{ color: currency === c ? palette.textInverse : palette.textDisabled }}>
                          {c}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <View style={styles.currencyLocked}>
                    <View style={{ flex: 1 }}>
                      <Text variant="label">{business?.currency} — {CURRENCY_NAMES[business?.currency ?? ''] ?? business?.currency}</Text>
                      <Text variant="caption" color="secondary">
                        Ceci est votre monnaie officielle
                      </Text>
                    </View>
                    <Ionicons name="lock-closed-outline" size={16} color={palette.textDisabled} />
                  </View>
                )}
              </View>
            </Card>
          )}

          {/* Mon profil — all roles */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">Mon profil</Text>
            <Input
              label="Nom affiché"
              value={userName}
              onChangeText={setUserName}
              placeholder={generateFallbackName(userId)}
              returnKeyType="done"
            />
          </Card>

          {/* À propos */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">À propos</Text>
            <Pressable onPress={() => Linking.openURL('https://patron.kolilink.com/privacy.html')} style={styles.linkRow}>
              <Text variant="body">Politique de confidentialité</Text>
              <Text variant="caption" color="secondary">›</Text>
            </Pressable>
            <Pressable onPress={() => Linking.openURL('https://wa.me/16094454809')} style={styles.linkRow}>
              <Text variant="body">Contacter le support</Text>
              <Text variant="caption" color="secondary">›</Text>
            </Pressable>
          </Card>

          {/* Apparence */}
          <Card style={styles.section}>
            <Text variant="label" color="secondary">Apparence</Text>
            <View style={styles.chipRow}>
              {(['system', 'light', 'dark'] as const).map(mode => {
                const label = mode === 'system' ? 'Auto' : mode === 'light' ? 'Clair' : 'Sombre';
                return (
                  <Pressable
                    key={mode}
                    onPress={() => setColorScheme(mode)}
                    style={[styles.chip, colorScheme === mode ? styles.chipActive : styles.chipGhost]}
                  >
                    <Text variant="label" style={{ color: colorScheme === mode ? palette.textInverse : palette.textDisabled }}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>

          {/* Danger — plain section, no loud box, at the very bottom */}
          <Card style={styles.section}>
            {!isAdmin && (
              <Pressable onPress={handleLeave} style={styles.dangerRow}>
                <Text style={styles.dangerText}>Quitter ce commerce</Text>
              </Pressable>
            )}

            {!showDeleteConfirm ? (
              <Pressable onPress={() => { setShowDeleteConfirm(true); setDeleteInput(''); }} style={styles.dangerRow}>
                <Text style={styles.dangerText}>Supprimer mon compte</Text>
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
                    style={{ flex: 1, alignItems: 'center', paddingVertical: spacing[2] }}
                  >
                    <Text variant="label" color="secondary">Annuler</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleDeleteAccount}
                    disabled={deleteInput !== 'SUPPRIMER' || deleting}
                    style={{ flex: 1, alignItems: 'center', paddingVertical: spacing[2],
                      opacity: deleteInput !== 'SUPPRIMER' || deleting ? 0.4 : 1 }}
                  >
                    <Text variant="label" style={{ color: palette.danger }}>
                      {deleting ? 'Suppression…' : 'Confirmer'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </Card>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe:    { flex: 1, backgroundColor: p.background },
    hdr:     {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    section: { gap: spacing[4] },

    chipRow:    { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
    chip:       { paddingHorizontal: spacing[4], paddingVertical: spacing[2], borderRadius: radius.full, borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface },
    chipActive: { backgroundColor: p.primary, borderColor: p.primary },
    chipGhost:  { borderColor: 'transparent', backgroundColor: 'transparent' },

    // Locked currency display
    currencyLocked: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      backgroundColor: p.surface, borderRadius: radius.md,
      borderWidth: 1, borderColor: p.border,
    },

    linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing[2] },

    // Danger — plain text rows, no border, no background tint
    dangerRow:  { paddingVertical: spacing[2] },
    dangerText: { fontSize: 15, color: p.danger },

    deleteConfirmBox: { gap: spacing[3] },
    deleteInput: {
      borderWidth: 1.5, borderColor: p.danger + '60', borderRadius: radius.md,
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      color: p.danger, fontWeight: '700' as const, fontSize: 16, letterSpacing: 2,
    },
  });
}
