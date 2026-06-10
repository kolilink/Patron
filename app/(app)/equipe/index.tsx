import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, FlatList, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { generateFallbackName } from '@/lib/id';
import { useEquipeStore, type Membre } from '@/stores/equipe';
import type { Role } from '@/src/types';

const ROLES: Role[] = ['manager', 'vendeur', 'investisseur'];

const ROLE_LABELS: Record<Role, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

const ROLE_BADGE_LABELS: Record<Role, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  manager: 'Gère le commerce sans pouvoir le supprimer',
  vendeur: 'Enregistre les ventes uniquement',
  investisseur: 'Voit les chiffres, ne touche à rien',
};

const ROLE_COLORS: Record<string, string> = {
  administrateur: colors.role.administrateur,
  manager: colors.role.manager,
  vendeur: colors.role.vendeur,
  investisseur: colors.role.investisseur,
};

function RoleBadge({ role }: { role: string }) {
  const c = ROLE_COLORS[role] ?? palette.primary;
  return (
    <View style={[styles.badge, { backgroundColor: c + '20' }]}>
      <Text variant="labelSmall" style={{ color: c, textTransform: 'capitalize' }}>
        {ROLE_BADGE_LABELS[role as Role] ?? role}
      </Text>
    </View>
  );
}


interface NewCodeModalProps {
  visible: boolean; onClose: () => void;
  onGenerate: (role: Role) => Promise<void>; saving: boolean;
  hasManager: boolean;
}

function NewCodeModal({ visible, onClose, onGenerate, saving, hasManager }: NewCodeModalProps) {
  const [role, setRole] = useState<Role>('vendeur');
  const [hasInteracted, setHasInteracted] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  const managerLocked = role === 'manager' && hasManager;
  const orderedRoles = hasManager ? (['vendeur', 'investisseur', 'manager'] as Role[]) : ROLES;

  useEffect(() => {
    if (visible) {
      setHasInteracted(false);
      setRole('vendeur');
      pulseAnim.setValue(1);
    } else {
      pulseRef.current?.stop();
    }
  }, [visible]);

  useEffect(() => {
    if (hasInteracted && !saving) {
      pulseRef.current?.stop();
      pulseRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.04, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
          Animated.timing(pulseAnim, { toValue: 1,    duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        ]),
      );
      pulseRef.current.start();
    } else {
      pulseRef.current?.stop();
      pulseRef.current = null;
      pulseAnim.setValue(1);
    }
    return () => { pulseRef.current?.stop(); };
  }, [hasInteracted, saving]);

  const handleSelectRole = (r: Role) => {
    setRole(r);
    if (!hasInteracted) setHasInteracted(true);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Inviter quelqu'un</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad}>
          <Text variant="body" color="secondary">
            Votre équipe s'agrandit — c'est une belle étape !
          </Text>
          <Text variant="body" color="secondary">
            Choisissez le rôle ci-dessous et un code valable de 24h sera créé pour votre nouveau membre :)
          </Text>
          <Text variant="label">Rôle</Text>
          <View style={styles.roleGrid}>
            {orderedRoles.map(r => {
              const isManagerFull = r === 'manager' && hasManager;
              const isSelected = role === r;
              return (
                <Pressable key={r} onPress={() => handleSelectRole(r)}
                  style={[
                    styles.roleChip,
                    isSelected && { backgroundColor: ROLE_COLORS[r], borderColor: ROLE_COLORS[r] },
                    isManagerFull && !isSelected && { opacity: 0.5 },
                  ]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text variant="label" style={{ color: isSelected ? palette.textInverse : palette.textPrimary }}>
                      {ROLE_LABELS[r]}
                    </Text>
                    {isManagerFull && (
                      <View style={styles.fullBadge}>
                        <Text variant="labelSmall" style={{ color: palette.textSecondary }}>1/1</Text>
                      </View>
                    )}
                  </View>
                  <Text variant="caption" style={{ color: isSelected ? palette.textInverse : palette.textSecondary }}>
                    {ROLE_DESCRIPTIONS[r]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {managerLocked && (
            <View style={styles.lockedNote}>
              <Ionicons name="time-outline" size={18} color={palette.warning} />
              <Text variant="bodySmall" style={{ flex: 1, color: palette.warning, fontWeight: '600', lineHeight: 20 }}>
                La gestion de plusieurs gérants arrive bientôt — restez à l'écoute 🙂
              </Text>
            </View>
          )}
        </ScrollView>
        {!managerLocked && hasInteracted && (
          <View style={styles.mfooter}>
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <Button
                label={saving ? 'Génération…' : 'Générer le code'}
                loading={saving}
                fullWidth
                size="lg"
                onPress={() => onGenerate(role)}
              />
            </Animated.View>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

interface CodeRevealModalProps {
  visible: boolean;
  code: string;
  role: Role;
  businessName: string;
  onClose: () => void;
}

function CodeRevealModal({ visible, code, role, businessName, onClose }: CodeRevealModalProps) {
  const roleColor = ROLE_COLORS[role] ?? palette.primary;
  const roleLabel = ROLE_LABELS[role];
  const shareMsg = `${businessName} vous invite à rejoindre son équipe sur Patron.\n\nCode d'accès : ${code}\n\nCe code est valable 24 heures.`;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <View style={{ width: 70 }} />
          <Text variant="h4">Invitation créée</Text>
          <Pressable onPress={onClose} style={{ width: 70, alignItems: 'flex-end' }}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
        </View>

        <View style={styles.revealBody}>
          <View style={[styles.badge, { backgroundColor: roleColor + '20', alignSelf: 'center' }]}>
            <Text variant="label" style={{ color: roleColor }}>{roleLabel}</Text>
          </View>

          <View style={styles.revealCodeBlock}>
            <Text variant="caption" color="secondary">Code d'invitation</Text>
            <Text style={styles.revealCode}>
              {code}
            </Text>
            <Text variant="caption" color="secondary">Valable 24 heures · usage unique</Text>
          </View>

          <View style={styles.revealActions}>
            <Button
              label="Partager par WhatsApp"
              fullWidth
              onPress={() =>
                Linking.openURL(`whatsapp://send?text=${encodeURIComponent(shareMsg)}`).catch(() =>
                  Share.share({ message: shareMsg }),
                )
              }
            />
            <Button
              label="Partager…"
              variant="secondary"
              fullWidth
              onPress={() => Share.share({ message: shareMsg })}
            />
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export default function EquipeScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const myMembershipId = session?.activeMembership?.id ?? '';
  const role = session?.activeMembership?.role;

  useEffect(() => {
    if (role && role !== 'administrateur') router.back();
  }, [role]);

  const { membres, codes, loading, saving, error, fetchMembres, fetchCodes, createCode, revokeCode, removeMembre, changeRole } = useEquipeStore();
  const [tab, setTab] = useState<'membres' | 'codes'>('membres');
  const [showNewCode, setShowNewCode] = useState(false);
  const [revealData, setRevealData] = useState<{ code: string; role: Role } | null>(null);

  const hasManager = membres.some(m => m.role === 'manager');

  useEffect(() => {
    if (!businessId) return;
    fetchMembres(businessId);
    fetchCodes(businessId);
  }, [businessId]);

  if (role && role !== 'administrateur') return null;

  const handleGenerateCode = async (role: Role) => {
    if (role === 'manager' && hasManager) {
      Alert.alert('Un seul gérant pour l\'instant', 'Bientôt, vous pourrez avoir plusieurs gérants dans votre commerce.');
      return;
    }
    const code = await createCode(businessId, userId, role);
    if (!code) { Alert.alert('Le code n\'est pas passé. On réessaie :)'); return; }
    setShowNewCode(false);
    setRevealData({ code, role });
  };

  const handleMemberOptions = (m: Membre) => {
    if (m.id === myMembershipId) return;
    Alert.alert(m.user_name || generateFallbackName(m.user_id), m.user_email, [
      {
        text: 'Changer le rôle',
        onPress: () => {
          const otherRoles = ROLES.filter(r => r !== m.role);
          Alert.alert('Nouveau rôle', '', [
            ...otherRoles.map(r => ({
              text: ROLE_LABELS[r],
              onPress: () => {
                if (r === 'manager' && hasManager) {
                  Alert.alert('Un seul gérant pour l\'instant', 'Bientôt, vous pourrez avoir plusieurs gérants dans votre commerce.');
                  return;
                }
                changeRole(m.id, r);
              },
            })),
            { text: 'Annuler', style: 'cancel' },
          ]);
        },
      },
      {
        text: 'Retirer du commerce',
        style: 'destructive',
        onPress: () => Alert.alert('Retirer ' + (m.user_name || generateFallbackName(m.user_id)) + ' ?', '', [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Retirer', style: 'destructive', onPress: () => removeMembre(m.id) },
        ]),
      },
      { text: 'Annuler', style: 'cancel' },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Équipe</Text>
        <Pressable onPress={() => setShowNewCode(true)}>
          <Text variant="label" style={{ color: palette.primary }}>+ Inviter</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {(['membres', 'codes'] as const).map(t => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text variant="label" style={{ color: tab === t ? palette.textInverse : palette.textSecondary }}>
              {t === 'membres' ? 'Membres' : "Codes d'invitation"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'membres' ? (
        loading && membres.length === 0 ? (
          <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
        ) : !loading && membres.length === 0 && error ? (
          <Text variant="body" color="secondary" style={styles.center}>Données non disponibles hors ligne</Text>
        ) : (
          <FlatList
            data={membres}
            keyExtractor={m => m.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text variant="body" color="secondary">Personne d'autre n'utilise ce commerce</Text>
                <Text variant="caption" color="secondary" style={{ textAlign: 'center', marginTop: spacing[1] }}>
                  Invitez un vendeur ou un gérant pour partager le travail
                </Text>
                <Button label="+ Inviter quelqu'un" size="sm" onPress={() => setShowNewCode(true)} style={{ marginTop: spacing[3] }} />
              </View>
            }
            renderItem={({ item }) => (
              <Pressable onPress={() => handleMemberOptions(item)}
                style={({ pressed }) => [styles.memberRow, pressed && { opacity: 0.75 }]}>
                <View style={[styles.avatar, { backgroundColor: ROLE_COLORS[item.role] + '20' }]}>
                  <Text variant="label" style={{ color: ROLE_COLORS[item.role] }}>
                    {(item.user_name || generateFallbackName(item.user_id))[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.nameRow}>
                    <Text variant="label">{item.user_name || generateFallbackName(item.user_id)}</Text>
                    {item.id === myMembershipId && <Text variant="caption" color="secondary">(vous)</Text>}
                  </View>
                  {item.user_phone
                    ? <Text variant="caption" color="secondary">{item.user_phone}</Text>
                    : <Text variant="caption" color="secondary">{item.user_email !== '—' ? item.user_email : 'Pas de contact'}</Text>
                  }
                </View>
                <RoleBadge role={item.role} />
              </Pressable>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
          />
        )
      ) : !loading && codes.length === 0 && error ? (
        <Text variant="body" color="secondary" style={styles.center}>Données non disponibles hors ligne</Text>
      ) : (
        <FlatList
          data={codes}
          keyExtractor={c => c.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<View style={styles.empty}><Text variant="body" color="secondary">Aucun code actif.</Text></View>}
          renderItem={({ item }) => {
            const expired = item.expires_at ? new Date(item.expires_at) < new Date() : false;
            return (
              <Card style={styles.codeCard}>
                <View style={styles.codeTop}>
                  <Text
                    variant="h3"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={{ flex: 1, color: expired ? palette.textDisabled : palette.primary }}
                  >
                    {item.code}
                  </Text>
                  <RoleBadge role={item.role} />
                </View>
                <View style={styles.codeMeta}>
                  <View style={styles.codeStatus}>
                    {!expired && <View style={styles.greenDot} />}
                    <Text variant="caption" color="secondary">
                      {expired
                        ? 'Expiré'
                        : `Valide · expire ${item.expires_at ? new Date(item.expires_at).toLocaleDateString('fr-FR') : '—'}`}
                    </Text>
                  </View>
                  <Pressable onPress={() => Alert.alert('Annuler ce code ?', '', [{ text: 'Non', style: 'cancel' }, { text: 'Oui, annuler', style: 'destructive', onPress: () => revokeCode(item.id) }])}>
                    <Text variant="caption" color="danger">Supprimer</Text>
                  </Pressable>
                </View>
                {!expired && (
                  <Pressable
                    onPress={() => {
                      const businessName = session?.activeBusiness?.name ?? 'Un commerce';
                      Share.share({
                        message: `${businessName} vous invite à rejoindre son équipe sur Patron.\n\nVotre code d'accès : ${item.code}\n\nCe code est valable jusqu'au ${item.expires_at ? new Date(item.expires_at).toLocaleDateString('fr-FR') : '—'}.`,
                      });
                    }}
                    style={styles.shareRow}
                  >
                    <Ionicons name="share-outline" size={14} color={palette.primary} />
                    <Text variant="bodySmall" style={{ color: palette.primary }}>Partager ce code</Text>
                  </Pressable>
                )}
              </Card>
            );
          }}
        />
      )}

      <NewCodeModal visible={showNewCode} onClose={() => setShowNewCode(false)}
        onGenerate={handleGenerateCode} saving={saving} hasManager={hasManager} />

      {revealData && (
        <CodeRevealModal
          visible
          code={revealData.code}
          role={revealData.role}
          businessName={session?.activeBusiness?.name ?? 'Un commerce'}
          onClose={() => setRevealData(null)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  tabs: { flexDirection: 'row', padding: spacing[4], gap: spacing[2] },
  tab: { flex: 1, paddingVertical: spacing[2], alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: palette.border },
  tabActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  list: { paddingBottom: spacing[10] },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: palette.surface },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  badge: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6 },
  codeCard: { marginHorizontal: spacing[5], marginVertical: spacing[2], gap: spacing[2] },
  codeTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeStatus: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  greenDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success[500] },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[10] },
  center: { textAlign: 'center', marginTop: spacing[10] },
  modalSafe: { flex: 1, backgroundColor: palette.background },
  mhdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  mpad: { padding: spacing[5], gap: spacing[4] },
  mfooter: { padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border },
  revealBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6], gap: spacing[8] },
  revealCodeBlock: { alignItems: 'center', gap: spacing[3] },
  revealCode: { fontSize: 36, lineHeight: 48, fontWeight: '700', color: palette.textPrimary, textAlign: 'center', width: '100%' },
  revealActions: { width: '100%', gap: spacing[3] },
  roleGrid: { gap: spacing[2] },
  roleChip: { padding: spacing[4], borderRadius: radius.lg, borderWidth: 1.5, borderColor: palette.border, gap: 4 },
  lockedNote: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], backgroundColor: palette.warningLight, borderRadius: radius.md, borderWidth: 1.5, borderColor: palette.warning, padding: spacing[4] },
  fullBadge: { backgroundColor: palette.border, borderRadius: radius.full, paddingHorizontal: spacing[2], paddingVertical: 2 },
});
