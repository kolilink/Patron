import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

// Local 4-digit PIN — lets a returning user restore their still-valid Supabase
// session without a fresh WhatsApp OTP. Only a salted hash is ever stored.

const PIN_HASH_KEY  = 'patron_pin_hash_v1';
const PIN_FAIL_KEY  = 'patron_pin_fail_count';
const LOCKED_KEY     = 'patron_locked_v1';

export const MAX_PIN_ATTEMPTS = 5;

function bytesToBase64(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

function randomSaltB64(): string {
  const buf = new Uint8Array(16);
  Crypto.getRandomValues(buf);
  return bytesToBase64(buf);
}

async function hashPin(pin: string, saltB64: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${saltB64}:${pin}`);
}

export async function setPin(pin: string): Promise<void> {
  const salt = randomSaltB64();
  const hash = await hashPin(pin, salt);
  await SecureStore.setItemAsync(PIN_HASH_KEY, `${salt}:${hash}`);
  await resetPinFailCount();
}

export async function hasPinSet(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(PIN_HASH_KEY)) !== null;
  } catch {
    return false;
  }
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(PIN_HASH_KEY);
  if (!stored) return false;
  const sepIndex = stored.indexOf(':');
  if (sepIndex === -1) return false;
  const salt = stored.slice(0, sepIndex);
  const expectedHash = stored.slice(sepIndex + 1);
  const actualHash = await hashPin(pin, salt);
  return actualHash === expectedHash;
}

export async function clearPin(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_HASH_KEY);
  await resetPinFailCount();
}

export async function getPinFailCount(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(PIN_FAIL_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function incrementPinFailCount(): Promise<number> {
  const next = (await getPinFailCount()) + 1;
  await SecureStore.setItemAsync(PIN_FAIL_KEY, String(next));
  return next;
}

export async function resetPinFailCount(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_FAIL_KEY);
}

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
