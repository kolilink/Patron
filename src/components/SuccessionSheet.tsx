import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { failAlert } from '@/src/components/ui/FailureView';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useEquipeStore, type Membre } from '@/stores/equipe';
import { haptics } from '@/lib/haptics';
import { successionBody } from '@/src/utils/succession';

// "Désignez un successeur" — shown when the person leaving (or deleting their
// account) is the LAST administrateur of a business that still has other
// members. The server refuses that exit (leave_or_delete_business /
// delete_my_account, migration_v239) because the business would be left with
// nobody in charge; this is the way through: pick who takes over, then the
// caller carries on with the leave. Nobody is removed — "vos vendeurs
// garderont leur accès".
//
// Promotion is the existing role change (memberships UPDATE through RLS, the
// v212 guard allows it: it only blocks DEMOTING the last admin), so it also
// sends the usual "role changed" notification to the new gérant.

const ROLE_LABEL: Record<string, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

interface Props {
  visible: boolean;
  onClose: () => void;
  businessId: string;
  businessName: string;
  /** The person leaving — never offered as their own successor. */
  userId: string;
  /** Called once a successor has been designated; the caller then continues the leave. */
  onDesignated: () => void;
}

export function SuccessionSheet({ visible, onClose, businessId, businessName, userId, onDesignated }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const membres = useEquipeStore(s => s.membres);
  const fetchMembres = useEquipeStore(s => s.fetchMembres);
  const changeRole = useEquipeStore(s => s.changeRole);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (visible) void fetchMembres(businessId);
  }, [visible, businessId, fetchMembres]);

  const candidates = membres.filter((m: Membre) => m.business_id === businessId && m.user_id !== userId);

  const designate = async (m: Membre) => {
    if (busyId) return;
    setBusyId(m.id);
    haptics.tap();
    try {
      const ok = await changeRole(m.id, 'administrateur');
      if (!ok) {
        haptics.error();
        failAlert('successorNotDesignated');
        return;
      }
      haptics.success();
      onDesignated();
    } catch {
      // failure: speaks — failAlert (no connection / refused), nothing changed
      failAlert('successorNotDesignated');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <FormSheet visible={visible} onClose={onClose} title="Désignez un successeur" cancelLabel="Annuler">
      <Text variant="body" color="secondary" style={styles.body}>{successionBody(businessName)}</Text>
      {candidates.length === 0 ? (
        <Text variant="bodySmall" color="secondary">
          Personne d'autre n'est dans ce commerce pour le moment.
        </Text>
      ) : candidates.map((m: Membre) => (
        <View key={m.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text variant="body">{m.display_name || m.user_name || 'Membre'}</Text>
            <Text variant="caption" color="secondary">{ROLE_LABEL[m.role] ?? m.role}</Text>
          </View>
          <Button
            label="Désigner gérant"
            size="sm"
            variant="secondary"
            loading={busyId === m.id}
            loadingLabel="Désignation"
            disabled={busyId !== null}
            onPress={() => designate(m)}
          />
        </View>
      ))}
    </FormSheet>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    body: { marginBottom: spacing[5], lineHeight: 22 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[3], paddingHorizontal: spacing[3],
      borderWidth: 1, borderColor: p.border, borderRadius: radius.md, backgroundColor: p.surface,
      marginBottom: spacing[2],
    },
  });
}
