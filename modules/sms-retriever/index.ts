import type { EventSubscription } from 'expo-modules-core';
import SmsRetrieverModule from './src/SmsRetrieverModule';

// Android only — WhatsApp's one-tap/zero-tap authentication autofill relies on the same
// SMS Retriever broadcast this wraps. No-ops on iOS, which has no equivalent mechanism
// (iOS gets its own autofill for free via OtpInput's textContentType="oneTimeCode").
export function startSmsRetriever(): Promise<void> {
  if (!SmsRetrieverModule?.start) return Promise.resolve();
  return SmsRetrieverModule.start();
}

export function stopSmsRetriever(): void {
  SmsRetrieverModule?.stop?.();
}

export function addSmsReceivedListener(
  listener: (event: { message: string }) => void,
): EventSubscription | null {
  return SmsRetrieverModule?.addListener?.('onSmsReceived', listener) ?? null;
}
