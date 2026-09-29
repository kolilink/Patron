import { AppSheet } from '@/src/components/ui/AppSheet';
import { useActivationPrimingStore } from '@/stores/activationPriming';
import { requestNotificationPermissionAndRegister } from '@/src/components/NotificationSetup';

// In-app permission-priming card. Shown once after the merchant's FIRST
// value moment (first sale, first credit sale, or first product write —
// whichever happens first), and at most once more later if they tapped
// "Plus tard" the first time (see stores/activationPriming.ts). Never shown
// at app open, never gates any feature or reward on the answer either way.
export function ActivationPrimingSheet() {
  const visible = useActivationPrimingStore(s => s.visible);
  const markResolved = useActivationPrimingStore(s => s.markResolved);
  const markDismissed = useActivationPrimingStore(s => s.markDismissed);

  return (
    <AppSheet
      visible={visible}
      onClose={markDismissed}
      icon="notifications-outline"
      title="Voulez-vous être prévenu quand un client paie ou qu'un crédit vieillit ?"
      body="Vous pouvez changer d'avis à tout moment dans les réglages de votre téléphone."
      action={{
        label: 'Continuer',
        onPress: async () => {
          await markResolved();
          void requestNotificationPermissionAndRegister();
        },
      }}
      secondaryAction={{ label: 'Plus tard', onPress: markDismissed }}
    />
  );
}
