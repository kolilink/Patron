import { Linking, Platform } from 'react-native';

// Opens WhatsApp itself (to find the OTP message). Never throws: a device with
// no WhatsApp installed must not produce an unhandled rejection — see
// CLAUDE.md's "Parametres screen" note on the same bug on the welcome screen.
//
// iOS dispatches a URL by scheme alone, so the bare `whatsapp://` opens the app
// to its chat list. Android matches ACTION_VIEW against full intent filters
// (scheme + host), and WhatsApp's manifest only declares `whatsapp://send`, so
// the bare scheme matches nothing → ActivityNotFoundException → a dead button.
// On Android we therefore try URLs WhatsApp does declare, in order, and stop at
// the first that opens: `whatsapp://send` (the app directly), then
// `https://wa.me/` (WhatsApp's verified web link; opens the app when installed).
export const WHATSAPP_URLS = {
  ios: ['whatsapp://'],
  android: ['whatsapp://send', 'https://wa.me/'],
} as const;

export async function openWhatsAppUrls(urls: readonly string[], open: (url: string) => Promise<unknown> = u => Linking.openURL(u)): Promise<boolean> {
  for (const url of urls) {
    try {
      await open(url);
      return true;
    } catch {
      // try the next form
    }
  }
  return false;
}

export function openWhatsApp(): void {
  void openWhatsAppUrls(Platform.OS === 'android' ? WHATSAPP_URLS.android : WHATSAPP_URLS.ios);
}

const SUPPORT_WA_URL = `https://wa.me/16094454809?text=${encodeURIComponent("Bonjour ! J'ai une question sur Patron 🙂")}`;

// One shared "contact support" link — same number and pre-filled greeting
// everywhere it's offered (landing screen, signup flow, ...), so the two
// never drift apart the way this codebase's copy has drifted elsewhere.
export function openSupportChat(): void {
  Linking.openURL(SUPPORT_WA_URL).catch(() => {});
}
