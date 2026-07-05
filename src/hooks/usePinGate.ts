import { useEffect, useState } from 'react';
import { hasPinSet } from '@/lib/pin';

/**
 * Resolves whether the current device has a local PIN configured, re-checked
 * whenever `sessionUserId` changes (e.g. right after a fresh login/registration
 * that has not gone through PIN setup yet). Returns `null` while the SecureStore
 * read is in flight — callers should treat that the same as "don't redirect yet"
 * to avoid a flash to the wrong screen.
 */
export function usePinGate(sessionUserId: string | undefined | null): boolean | null {
  const [pinSet, setPinSet] = useState<boolean | null>(null);

  useEffect(() => {
    if (!sessionUserId) {
      setPinSet(null);
      return;
    }
    let cancelled = false;
    setPinSet(null);
    hasPinSet().then(v => { if (!cancelled) setPinSet(v); });
    return () => { cancelled = true; };
  }, [sessionUserId]);

  return pinSet;
}
