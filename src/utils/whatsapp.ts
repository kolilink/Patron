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

const SUPPORT_WA_URL = `https://wa.me/16094454809?text=${encodeURIComponent("Bonjour ! J'ai une question sur Patron 🙂")}`;

// One shared "contact support" link — same number and pre-filled greeting
// everywhere it's offered (landing screen, signup flow, ...), so the two
// never drift apart the way this codebase's copy has drifted elsewhere.
export function openSupportChat(): void {
  Linking.openURL(SUPPORT_WA_URL).catch(() => {});
}
