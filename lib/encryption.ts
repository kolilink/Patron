import * as SecureStore from 'expo-secure-store';
import { getRandomValues } from 'expo-crypto';
import CryptoJS from 'crypto-js';

// AES-256-CBC application-layer encryption for SQLite cache, via crypto-js
// (pure JavaScript, no native module — see below for why that matters).
// Key generated once per install, stored in SecureStore (hardware-backed on
// Android/iOS). Sync queue is intentionally left unencrypted — it's
// transient and cleared after sync.
//
// Previously used globalThis.crypto.subtle (Hermes's built-in WebCrypto,
// AES-GCM) — RN/Expo's own docs claim this is available on RN 0.76+/Expo
// SDK 54+, which this app targets, but on the real installed production
// build `crypto.subtle` was confirmed `undefined` (found via an on-device
// diagnostic after every cache write silently failed for days — see
// CLAUDE.md's "Offline read caches" section). That's a property of the
// compiled native binary, not something any JS-side fix can patch — the
// only way to actually deliver a fix via OTA (no new native build) is to
// stop depending on native WebCrypto entirely. crypto-js has zero
// dependencies and no native code, so it works identically regardless of
// what the Hermes build does or doesn't expose.
//
// Trade-off: CBC (this) has no built-in tamper-detection the way GCM
// (authenticated encryption) does — a corrupted/tampered ciphertext will
// decrypt to garbage instead of throwing. Acceptable here: this cache never
// leaves the device or crosses a network boundary, so the actual goal
// (confidentiality of cached business data at rest, e.g. against another
// app or a rooted/stolen device reading the SQLite file directly) is still
// met. Every decrypt() call site already treats a decrypt failure as
// "no cache" (falls back to blank/fetch), so garbage output on tampering
// degrades the same way a thrown error would.

const KEY_STORE_KEY = 'patron_db_enc_key_v1';
const IV_BYTES = 16; // AES block size

let _key: CryptoJS.lib.WordArray | null = null;

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  getRandomValues(buf);
  return buf;
}

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

function bytesToWordArray(bytes: Uint8Array): CryptoJS.lib.WordArray {
  return CryptoJS.lib.WordArray.create(bytes as unknown as number[]);
}

function wordArrayToBytes(wa: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(wa.sigBytes);
  for (let i = 0; i < wa.sigBytes; i++) {
    out[i] = (wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

async function getKey(): Promise<CryptoJS.lib.WordArray> {
  if (_key) return _key;

  let rawB64 = await SecureStore.getItemAsync(KEY_STORE_KEY);
  if (!rawB64) {
    rawB64 = bytesToBase64(randomBytes(32)); // 256-bit key
    await SecureStore.setItemAsync(KEY_STORE_KEY, rawB64);
  }

  _key = CryptoJS.enc.Base64.parse(rawB64);
  return _key;
}

// Returns base64(16-byte IV + AES-CBC ciphertext).
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const ivBytes = randomBytes(IV_BYTES);
  const iv = bytesToWordArray(ivBytes);

  const result = CryptoJS.AES.encrypt(plaintext, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const cipherBytes = wordArrayToBytes(result.ciphertext);

  const combined = new Uint8Array(IV_BYTES + cipherBytes.length);
  combined.set(ivBytes, 0);
  combined.set(cipherBytes, IV_BYTES);
  return bytesToBase64(combined);
}

// Decodes base64(IV + ciphertext) and decrypts.
export async function decrypt(data: string): Promise<string> {
  const key = await getKey();
  const combined = base64ToBytes(data);
  const iv = bytesToWordArray(combined.slice(0, IV_BYTES));
  const cipherBytes = combined.slice(IV_BYTES);

  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: bytesToWordArray(cipherBytes),
  });
  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return decrypted.toString(CryptoJS.enc.Utf8);
}
