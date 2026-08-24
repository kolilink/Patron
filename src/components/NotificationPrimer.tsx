import { useEffect, useRef, useState } from 'react';
import { AppSheet } from '@/src/components/ui/AppSheet';
import { checkNotificationPermission, requestNotificationPermission } from '@/src/components/NotificationSetup';
import { getKV, setKV } from '@/lib/db';

function primerShownKey(userId: string): string {
  return `notif_primer_shown_${userId}`;
}

interface Props {
  userId: string;
  // Parent only sets this true once there's real context to prime with
  // (activeBusiness exists, not demo mode) — mirrors why the raw OS dialog
  // used to fire wrong: asking before the user has seen any value at all.
  active: boolean;
  // True from the moment this component might still show itself through to
  // the moment it's resolved (shown-and-dismissed, or determined
  // unnecessary). app/(app)/_layout.tsx uses this to hold ActivationForkOverlay
  // back so the two sheets never fight for the screen at once — the same
  // "two Modals racing" bug class already fixed elsewhere in this app.
  onBlockingChange: (blocking: boolean) => void;
}

// Soft-ask before the real OS permission dialog — the pattern every major
// app (Facebook, Instagram, ...) uses, because the raw system prompt is
// generic and un-primed, and on iOS you only get ONE real shot at it per
// install. This sheet explains a concrete reason first; only tapping
// "Activer les notifications" calls requestNotificationPermission(), which
// is what actually shows the OS dialog. "Plus tard" costs nothing — the
// real OS ask is still available next time this evaluates false-then-true
// (e.g. a later session before the KV flag below is set from that resolve).
export function NotificationPrimer({ userId, active, onBlockingChange }: Props) {
  const [visible, setVisible] = useState(false);
  const resolvedOnce = useRef(false);

  useEffect(() => {
    if (!active || resolvedOnce.current) return;
    let cancelled = false;

    (async () => {
      const alreadyShown = await getKV(primerShownKey(userId));
      if (cancelled || alreadyShown === 'true') {
        if (!cancelled) { resolvedOnce.current = true; onBlockingChange(false); }
        return;
      }

      const perm = await checkNotificationPermission();
      if (cancelled) return;

      // Nothing to prime for: already granted, native module unavailable
      // (older binary via OTA), or the user already hard-denied the real
      // dialog at some point — canAskAgain false means tapping "Activer"
      // here would show nothing at all, which reads as broken. Mark shown
      // either way so this check doesn't re-run every cold start.
      if (!perm || perm.granted || !perm.canAskAgain) {
        setKV(primerShownKey(userId), 'true').catch(() => {});
        resolvedOnce.current = true;
        onBlockingChange(false);
        return;
      }

      setVisible(true);
    })();

    return () => { cancelled = true; };
  }, [active, userId]);

  const resolve = () => {
    setKV(primerShownKey(userId), 'true').catch(() => {});
    setVisible(false);
    resolvedOnce.current = true;
    onBlockingChange(false);
  };

  return (
    <AppSheet
      visible={visible}
      onClose={resolve}
      icon="notifications-outline"
      title="Ne manquez plus rien"
      body="Recevez un résumé de votre journée chaque soir, et une alerte le jour où vous franchissez un nouveau cap de ventes."
      action={{ label: 'Activer les notifications', onPress: () => { void requestNotificationPermission(); } }}
      secondaryAction={{ label: 'Plus tard', onPress: () => {} }}
    />
  );
}
