import { useCallback, useRef, useState } from 'react';
import type { Audio } from 'expo-av';

// expo-av's native module only exists once the app has been rebuilt with this
// dependency linked in — requiring it eagerly would crash older binaries that
// receive this code via an OTA update. Same guard as app/(app)/discussions.tsx
// and app/(app)/messages/[room_id].tsx's local getAudio() helpers — expo-av
// is already a linked dependency there, but this hook has its own callers.
function getAudio(): typeof Audio | null {
  try {
    return require('expo-av').Audio;
  } catch {
    return null;
  }
}

const MAX_DURATION_S = 60;

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  // Live mic amplitude samples (0–1, ~every 100ms) for VoiceWaveformBars —
  // same shape/mapping as discussions.tsx's recorder, so the two recording
  // UIs read identically. Alpha never persists this (no playback), so it's
  // reset on stop/cancel rather than returned.
  const [amplitudes, setAmplitudes] = useState<number[]>([]);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Source of truth for elapsed time inside stop()/the auto-stop timer —
  // the `duration` state alone would be stale there, since a closure
  // created when start() ran (and captured by the setInterval callback)
  // keeps referencing that render's `duration`, not later updates.
  const durationRef = useRef(0);

  const stop = useCallback(async (): Promise<{ uri: string; duration: number } | null> => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setAmplitudes([]);

    if (!rec) return null;
    try {
      await rec.stopAndUnloadAsync();
    } catch { /* already stopped */ }
    await getAudio()?.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });

    const finalDuration = durationRef.current;
    durationRef.current = 0;
    setDuration(0);

    const uri = rec.getURI();
    if (!uri || finalDuration < 1) return null;
    return { uri, duration: finalDuration };
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    try {
      const A = getAudio();
      if (!A) return false;

      const { granted } = await A.requestPermissionsAsync();
      if (!granted) return false;

      await A.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      const rec = new A.Recording();
      await rec.prepareToRecordAsync({
        isMeteringEnabled: true,
        android: {
          extension: '.m4a',
          outputFormat: A.AndroidOutputFormat.MPEG_4,
          audioEncoder: A.AndroidAudioEncoder.AAC,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: A.IOSOutputFormat.MPEG4AAC,
          audioQuality: A.IOSAudioQuality.MEDIUM,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {},
      });

      // Same -50dB..0dB → 0..1 mapping + power curve as discussions.tsx's
      // recorder, so normal speech sits at ~45% bar height instead of 80%.
      rec.setOnRecordingStatusUpdate(status => {
        if (status.isRecording && status.metering !== undefined) {
          const raw = Math.max(0, Math.min(1, (status.metering + 50) / 50));
          setAmplitudes(prev => [...prev, Math.pow(raw, 1.5)]);
        }
      });
      await rec.setProgressUpdateInterval(100);
      await rec.startAsync();

      recordingRef.current = rec;
      durationRef.current = 0;
      setIsRecording(true);
      setDuration(0);
      setAmplitudes([]);

      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        setDuration(durationRef.current);
        if (durationRef.current >= MAX_DURATION_S) void stop();
      }, 1000);
      return true;
    } catch {
      return false;
    }
  }, [stop]);

  // Discards the recording without returning a URI — used when the user
  // taps cancel instead of the stop/checkmark button.
  const cancel = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const rec = recordingRef.current;
    recordingRef.current = null;
    durationRef.current = 0;
    setIsRecording(false);
    setDuration(0);
    setAmplitudes([]);
    if (rec) void rec.stopAndUnloadAsync().catch(() => {});
  }, []);

  return { isRecording, duration, amplitudes, start, stop, cancel };
}
