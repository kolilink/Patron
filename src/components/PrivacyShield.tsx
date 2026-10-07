import { useEffect, useRef, useState } from 'react';
import { AppState, Image, StyleSheet, View } from 'react-native';
import { brand } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

// Must match BACKGROUND_MS in app/(app)/_layout.tsx (the lock threshold).
const LOCK_AFTER_MS = 2 * 60_000;
// Ceiling on how long the shield waits for the lock redirect after a long
// background (e.g. no session, so lock() never flips `locked`).
const LOCK_WAIT_CEILING_MS = 1500;

// Full-screen brand cover rendered the instant the app leaves the foreground.
// iOS takes its app-switcher snapshot as the app backgrounds and shows it on
// return before JS can draw anything, so a shield that only appears once the
// 2-minute lock timer fires would leak a frame of real content. This one is
// shown on a real 'background' transition immediately (never on 'inactive'); the 2-minute timer (in
// app/(app)/_layout.tsx) still decides separately whether biometric auth is
// required.
//
// Dismissal: under 2 minutes away → drop straight away, no auth. Over 2
// minutes → hold until the lock route (same purple field) is up, so there's
// no frame of app content between the shield leaving and /verrouille arriving.
export function PrivacyShield() {
  const [visible, setVisible] = useState(false);
  const leftAt = useRef<number | null>(null);
  const coverRef = useRef<View>(null);
  // Hide on the native side immediately (setState commits after the first frame).
  const hideNow = () => {
    coverRef.current?.setNativeProps({ style: { opacity: 0 } });
    setVisible(false);
  };

  useEffect(() => {
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    const clearWait = () => {
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      unsub?.();
      unsub = null;
    };

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        const away = leftAt.current === null ? 0 : Date.now() - leftAt.current;
        leftAt.current = null;
        clearWait();
        if (away < LOCK_AFTER_MS || useAuthStore.getState().locked) {
          hideNow();
          return;
        }
        unsub = useAuthStore.subscribe((state) => {
          if (state.locked) { clearWait(); hideNow(); }
        });
        waitTimer = setTimeout(() => { clearWait(); hideNow(); }, LOCK_WAIT_CEILING_MS);
        return;
      }
      // 'inactive' is what Control Center / Notification Center peeks (and an
      // incoming-call banner) produce — the app is left exactly as it was, so
      // nothing happens: no shield, no clock. Only a real 'background'
      // transition covers the screen and starts the 2-minute clock.
      if (next !== 'background') return;
      if (leftAt.current === null) leftAt.current = Date.now();
      clearWait();
      coverRef.current?.setNativeProps({ style: { opacity: 1 } });
      setVisible(true);
    });
    return () => { clearWait(); sub.remove(); };
  }, []);

  if (!visible) return null;
  return (
    <View ref={coverRef} style={styles.cover} pointerEvents="auto">
      <Image source={require('@/assets/mark-white.png')} style={styles.mark} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: brand.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { width: 120, height: 120 },
});
