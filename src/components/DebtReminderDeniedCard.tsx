import { useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { useTheme, spacing } from '@/src/theme';
import { getKV, setKV } from '@/lib/db';
import { checkNotificationPermission } from '@/src/components/NotificationSetup';
import { deniedExplainerPendingKey } from '@/src/components/PaymentReminderAsker';

function shownKey(userId: string) { return `debt_asker_denied_shown_${userId}`; }

interface Props {
  userId: string;
  // Bumped by Accueil every time PaymentReminderAsker reports a fresh
  // denial (see its onDenied prop) — this card mounts once, at Accueil's
  // very first render, long before any denial can happen, so its own
  // mount-time check alone would never see the flag turn true. A denial
  // also doesn't cause a real react-navigation focus change (the OS
  // permission sheet isn't a screen transition), so a useFocusEffect
  // wouldn't catch it either — this explicit signal is what actually
  // triggers the re-check at the right moment.
  refreshSignal: number;
}

// Shown exactly once, right on the dashboard, after PaymentReminderAsker's
// "Activer les rappels" comes back denied from the real OS prompt — never a
// blocking screen, just a plain dismissible card alongside everything else
// on Accueil. Two KV flags, not one: `pending` is set the instant the denial
// happens (by PaymentReminderAsker, which has no dashboard UI of its own to
// show this in); `shown` is set once this card has actually been displayed
// and dismissed, so it can never come back after that even if `pending`
// somehow lingers.
export function DebtReminderDeniedCard({ userId, refreshSignal }: Props) {
  const { palette } = useTheme();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [alreadyShown, pending] = await Promise.all([
        getKV(shownKey(userId)),
        getKV(deniedExplainerPendingKey(userId)),
      ]);
      if (cancelled || alreadyShown === 'true' || pending !== 'true') return;

      // Belt-and-suspenders: only actually show it if the OS still reports
      // denied right now (e.g. not already fixed from a previous Settings
      // visit between the denial and this check).
      const perm = await checkNotificationPermission();
      if (cancelled) return;
      if (perm && !perm.granted && !perm.canAskAgain) {
        setVisible(true);
      } else {
        void setKV(deniedExplainerPendingKey(userId), 'false');
      }
    })();
    return () => { cancelled = true; };
  }, [userId, refreshSignal]);

  const dismiss = () => {
    setVisible(false);
    void setKV(shownKey(userId), 'true');
    void setKV(deniedExplainerPendingKey(userId), 'false');
  };

  const openSettings = () => {
    Linking.openSettings().catch(() => {});
    dismiss();
  };

  if (!visible) return null;

  return (
    <Card style={styles.card}>
      <Text variant="label">Les rappels sont désactivés.</Text>
      <Text variant="body" color="secondary">
        Vous pouvez les réactiver à tout moment dans les réglages.
      </Text>
      <Button label="Ouvrir les réglages" onPress={openSettings} size="sm" style={styles.action} />
      <Text
        variant="label"
        style={[styles.closeLink, { color: palette.textSecondary }]}
        onPress={dismiss}
      >
        Fermer
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing[2] },
  action: { alignSelf: 'flex-start', marginTop: spacing[2] },
  closeLink: { alignSelf: 'center', paddingVertical: spacing[1] },
});
