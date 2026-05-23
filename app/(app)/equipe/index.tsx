import { useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useEquipeStore, type Membre } from '@/stores/equipe';
import type { Role } from '@/src/types';

const ROLES: Role[] = ['manager', 'vendeur', 'investisseur'];
const ROLE_LABELS: Record<Role, string> = { administrateur: 'Admin', manager: 'Manager', vendeur: 'Vendeur', investisseur: 'Investisseur' };
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
      <Text variant="labelSmall" style={{ color: c, textTransform: 'capitalize' }}>{ROLE_LABELS[role as Role] ?? role}</Text>
    </View>
  );
}

interface NewCodeModalProps {
  visible: boolean; onClose: () => void;
  onGenerate: (role: Role) => Promise<void>; saving: boolean;
}
function NewCodeModal({ visible, onClose, onGenerate, saving }: NewCodeModalProps) {
  const [role, setRole] = useState<Role>('vendeur');
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Inviter un membre</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad}>
          <Text variant="body" color="secondary">
            Choisissez le rôle de la personne à inviter. Un code à usage unique valable 7 jours sera généré.
          </Text>
          <Text variant="label">Rôle</Text>
          <View style={styles.roleGrid}>
            {ROLES.map(r => (
              <Pressable key={r} onPress={() => setRole(r)}
                style={[styles.roleChip, role === r && { backgroundColor: ROLE_COLORS[r], borderColor: ROLE_COLORS[r] }]}>
                <Text variant="label" style={{ color: role === r ? palette.textInverse : palette.textPrimary }}>
                  {ROLE_LABELS[r]}
                </Text>
                <Text variant="caption" style={{ color: role === r ? palette.textInverse : palette.textSecondary }}>
                  {r === 'manager' ? 'Ventes + stock + rapports' : r === 'vendeur' ? 'Caisse uniquement' : 'Lecture seule'}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
        <View style={styles.mfooter}>
          <Button label={saving ? 'Génération…' : 'Générer le code'} loading={saving} fullWidth size="lg"
            onPress={() => onGenerate(role)} />
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

  const { membres, codes, loading, saving, fetchMembres, fetchCodes, createCode, revokeCode, removeMembre, changeRole } = useEquipeStore();
  const [tab, setTab] = useState<'membres' | 'codes'>('membres');
  const [showNewCode, setShowNewCode] = useState(false);

  useEffect(() => {
    if (!businessId) return;
    fetchMembres(businessId);
    fetchCodes(businessId);
  }, [businessId]);

  const handleGenerateCode = async (role: Role) => {
    const code = await createCode(businessId, userId, role);
    if (!code) { Alert.alert('Erreur', 'Impossible de générer le code.'); return; }
    setShowNewCode(false);
    Alert.alert(
      'Code créé : ' + code,
      'Valable 7 jours, usage unique. Partagez-le avec la personne à inviter.',
      [
        {
          text: 'Copier & Partager',
          onPress: () => Share.share({
            message: `${session?.activeBusiness?.name ?? 'Un commerce'} vous invite à rejoindre son équipe sur Patron.\n\nVotre code d'accès : ${code}\n\nCe code est valable 7 jours.`,
          }),
        },
        { text: 'Fermer' },
      ],
    );
  };

  const handleMemberOptions = (m: Membre) => {
    if (m.id === myMembershipId) return; // can't edit yourself
    Alert.alert(m.user_name, m.user_email, [
      {
        text: 'Changer le rôle',
        onPress: () => {
          const otherRoles = ROLES.filter(r => r !== m.role);
          Alert.alert('Nouveau rôle', '', [
            ...otherRoles.map(r => ({ text: ROLE_LABELS[r], onPress: () => changeRole(m.id, r) })),
            { text: 'Annuler', style: 'cancel' },
          ]);
        },
      },
      {
        text: 'Retirer du commerce',
        style: 'destructive',
        onPress: () => Alert.alert('Retirer ' + m.user_name + ' ?', '', [
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
              {t === 'membres' ? `Membres (${membres.length})` : `Codes d'invitation`}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'membres' ? (
        loading && membres.length === 0 ? (
          <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
        ) : (
          <FlatList
            data={membres}
            keyExtractor={m => m.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Pressable onPress={() => handleMemberOptions(item)}
                style={({ pressed }) => [styles.memberRow, pressed && { opacity: 0.75 }]}>
                <View style={[styles.avatar, { backgroundColor: ROLE_COLORS[item.role] + '20' }]}>
                  <Text variant="label" style={{ color: ROLE_COLORS[item.role] }}>
                    {item.user_name[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.nameRow}>
                    <Text variant="label">{item.user_name}</Text>
                    {item.id === myMembershipId && <Text variant="caption" color="secondary">(vous)</Text>}
                  </View>
                  <Text variant="caption" color="secondary">{item.user_email}</Text>
                </View>
                <RoleBadge role={item.role} />
              </Pressable>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
          />
        )
      ) : (
        <FlatList
          data={codes}
          keyExtractor={c => c.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<View style={styles.empty}><Text variant="body" color="secondary">Aucun code actif.</Text></View>}
          renderItem={({ item }) => {
            const expired = item.expires_at ? new Date(item.expires_at) < new Date() : false;
            const used = (item.max_uses != null && item.uses >= item.max_uses);
            return (
              <Card style={styles.codeCard}>
                <View style={styles.codeTop}>
                  <Text variant="h3" style={{ letterSpacing: 4, color: (expired || used) ? palette.textDisabled : palette.primary }}>
                    {item.code}
                  </Text>
                  <RoleBadge role={item.role} />
                </View>
                <View style={styles.codeMeta}>
                  <View style={styles.codeStatus}>
                    {!expired && !used && <View style={styles.greenDot} />}
                    <Text variant="caption" color="secondary">
                      {expired ? 'Expiré' : used ? 'Utilisé' : `Valide · expire ${item.expires_at ? new Date(item.expires_at).toLocaleDateString('fr-FR') : '—'}`}
                    </Text>
                  </View>
                  <Pressable onPress={() => Alert.alert('Révoquer ?', '', [{ text: 'Annuler', style: 'cancel' }, { text: 'Révoquer', style: 'destructive', onPress: () => revokeCode(item.id) }])}>
                    <Text variant="caption" color="danger">Révoquer</Text>
                  </Pressable>
                </View>
                {!expired && !used && (
                  <Pressable
                    onPress={() => Share.share({
                      message: `${session?.activeBusiness?.name ?? 'Un commerce'} vous invite à rejoindre son équipe sur Patron.\n\nVotre code d'accès : ${item.code}\n\nCe code est valable jusqu'au ${item.expires_at ? new Date(item.expires_at).toLocaleDateString('fr-FR') : '—'}.`,
                    })}
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
        onGenerate={handleGenerateCode} saving={saving} />
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
  roleGrid: { gap: spacing[2] },
  roleChip: { padding: spacing[4], borderRadius: radius.lg, borderWidth: 1.5, borderColor: palette.border, gap: 4 },
});
