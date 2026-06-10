import * as SecureStore from 'expo-secure-store';
import { getRandomValues } from 'expo-crypto';

// AES-256-GCM application-layer encryption for SQLite cache.
// Key generated once per install, stored in SecureStore (hardware-backed on Android/iOS).
// Sync queue is intentionally left unencrypted — it's transient and cleared after sync.

const KEY_STORE_KEY = 'patron_db_enc_key_v1';

// SubtleCrypto from Hermes's built-in WebCrypto API (available in RN 0.76+ / Expo SDK 54+).
// Typed manually to avoid requiring DOM lib in tsconfig.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const subtle = (globalThis as any).crypto?.subtle as {
  importKey(format: string, keyData: ArrayBuffer, algorithm: { name: string; length: number }, extractable: boolean, keyUsages: string[]): Promise<unknown>;
  encrypt(algorithm: { name: string; iv: Uint8Array }, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: string; iv: Uint8Array }, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
} | undefined;

// Loaded once per JS session — avoids a SecureStore read on every cache call.
let _cryptoKey: unknown | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  getRandomValues(buf);
  return buf;
}

async function getKey(): Promise<unknown> {
  if (_cryptoKey) return _cryptoKey;
  if (!subtle) throw new Error('SubtleCrypto unavailable');

  let rawB64 = await SecureStore.getItemAsync(KEY_STORE_KEY);

  if (!rawB64) {
    const raw = randomBytes(32); // 256-bit key
    rawB64 = bytesToBase64(raw);
    await SecureStore.setItemAsync(KEY_STORE_KEY, rawB64);
  }

  const rawBytes = base64ToBytes(rawB64);
  _cryptoKey = await subtle.importKey(
    'raw',
    rawBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return _cryptoKey;
}

// Returns base64(12-byte IV + AES-GCM ciphertext).
export async function encrypt(plaintext: string): Promise<string> {
  if (!subtle) throw new Error('SubtleCrypto unavailable');
  const key = await getKey();
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded.buffer as ArrayBuffer);
  const cipher = new Uint8Array(cipherBuf);

  const combined = new Uint8Array(12 + cipher.length);
  combined.set(iv, 0);
  combined.set(cipher, 12);
  return bytesToBase64(combined);
}

// Decodes base64(IV + ciphertext) and decrypts. Throws on tampered/wrong-key data.
export async function decrypt(data: string): Promise<string> {
  if (!subtle) throw new Error('SubtleCrypto unavailable');
  const key = await getKey();
  const combined = base64ToBytes(data);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher.buffer as ArrayBuffer);
  return new TextDecoder().decode(plainBuf);
}
