import * as SecureStore from 'expo-secure-store';

// Soft app-lock flag — set when the user explicitly locks (Paramètres →
// "Verrouiller") or when the background timer re-locks the app. Session
// resume from a locked state always goes through biometric (see
// unlockWithBiometric in stores/auth.ts) or a full WhatsApp OTP re-login;
// there is no PIN fallback.

const LOCKED_KEY = 'patron_locked_v1';

export async function isLocked(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(LOCKED_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setLocked(value: boolean): Promise<void> {
  if (value) {
    await SecureStore.setItemAsync(LOCKED_KEY, '1');
  } else {
    await SecureStore.deleteItemAsync(LOCKED_KEY);
  }
}
