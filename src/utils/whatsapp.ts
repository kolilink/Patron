import { Linking } from 'react-native';

// Bare Linking.openURL() on a whatsapp:// scheme throws an unhandled
// rejection on a device with no WhatsApp installed — see CLAUDE.md's
// "Parametres screen" note on the same bug on the welcome screen's support
// link. `whatsapp://` with no path opens the app straight to its chat list
// (undocumented but widely relied on), used here as a fallback for someone
// who can't find the OTP notification and wants to check WhatsApp directly.
export function openWhatsApp(): void {
  Linking.openURL('whatsapp://').catch(() => {});
}
