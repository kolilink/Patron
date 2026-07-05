import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import type { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors, useTheme } from '@/src/theme';
import { useChatStore } from '@/stores/chat';
import type { ChatMessage } from '@/src/types';

// expo-av's native module only exists once the app has been rebuilt with this
// dependency linked in — requiring it eagerly would crash older binaries that
// receive this code via an OTA update. Load it lazily so they degrade silently.
function getAudio(): typeof Audio | null {
  try {
    return require('expo-av').Audio;
  } catch {
    return null;
  }
}

// ─── Waveform ────────────────────────────────────────────────────────────────

const BAR_COUNT = 26;
const BAR_W     = 2;
const BAR_GAP   = 1.5;
const BAR_MAX_H = 22;
const BAR_MIN_H = 2;

function WaveformBars({ samples, progress, isOwn }: {
  samples: number[];
  progress: number;  // 0–1
  isOwn: boolean;
}) {
  const bars = useMemo(() => {
    if (samples.length === 0) {
      return Array.from({ length: BAR_COUNT }, (_, i) =>
        0.15 + 0.6 * Math.abs(Math.sin(i * 0.4))
      );
    }
    return Array.from({ length: BAR_COUNT }, (_, i) => {
      const idx = Math.floor(i * samples.length / BAR_COUNT);
      return Math.max(0.08, samples[Math.min(idx, samples.length - 1)]);
    });
  }, [samples]);

  const playedUpTo = Math.floor(progress * BAR_COUNT);

  return (
    <View style={styles.barsRow}>
      {bars.map((amp, i) => {
        const played = i < playedUpTo;
        return (
          <View
            key={i}
            style={{
              width: BAR_W,
              height: BAR_MIN_H + amp * (BAR_MAX_H - BAR_MIN_H),
              borderRadius: 2,
              backgroundColor: played
                ? (isOwn ? 'rgba(255,255,255,0.92)' : colors.primary[500])
                : (isOwn ? 'rgba(255,255,255,0.32)' : colors.neutral[300]),
            }}
          />
        );
      })}
    </View>
  );
}

// ─── Duration formatter ───────────────────────────────────────────────────────

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Speed cycle ─────────────────────────────────────────────────────────────

const SPEEDS = [1, 1.5, 2] as const;
type Speed = 1 | 1.5 | 2;

// ─── VoiceMessageBubble ───────────────────────────────────────────────────────

export function VoiceMessageBubble({ msg, isOwn }: {
  msg: ChatMessage;
  isOwn: boolean;
}) {
  const { palette } = useTheme();
  const currentlyPlayingVoiceId = useChatStore(s => s.currentlyPlayingVoiceId);
  const setCurrentlyPlayingVoice = useChatStore(s => s.setCurrentlyPlayingVoice);

  const soundRef    = useRef<Audio.Sound | null>(null);
  const waveWidthRef = useRef(0);  // layout width of the waveform area, no re-render needed
  const [playing,  setPlaying]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed,    setSpeed]    = useState<Speed>(1);
  const totalSecs = msg.voice_duration ?? 0;
  const [elapsed,  setElapsed]  = useState(0);

  const isActive = currentlyPlayingVoiceId === msg.id;

  // Stop playback if another voice message starts
  useEffect(() => {
    if (!isActive && playing) {
      soundRef.current?.pauseAsync().catch(() => {});
      setPlaying(false);
    }
  }, [isActive]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  // Shared status callback — stable reference (totalSecs & setCurrentlyPlayingVoice don't change)
  const onStatus = useCallback((status: any) => {
    if (!status.isLoaded) return;
    const dur = status.durationMillis ?? (totalSecs * 1000);
    const pos = status.positionMillis ?? 0;
    setProgress(dur > 0 ? pos / dur : 0);
    setElapsed(pos / 1000);

    if (status.didJustFinish) {
      setPlaying(false);
      setProgress(0);
      setElapsed(0);
      setCurrentlyPlayingVoice(null);
      const s = soundRef.current;
      soundRef.current = null;
      setTimeout(() => s?.unloadAsync().catch(() => {}), 50);
    }
  }, [totalSecs, setCurrentlyPlayingVoice]);

  // Ensure the sound object exists; returns false if voice_url missing
  const ensureSound = useCallback(async (): Promise<boolean> => {
    if (!msg.voice_url) return false;
    if (soundRef.current) return true;

    const A = getAudio();
    if (!A) return false;

    await A.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    const { sound } = await A.Sound.createAsync(
      { uri: msg.voice_url },
      { shouldPlay: false, rate: speed, progressUpdateIntervalMillis: 80 },
      onStatus,
    );
    soundRef.current = sound;
    return true;
  }, [msg.voice_url, speed, onStatus]);

  const handlePlayPause = useCallback(async () => {
    try {
      if (playing) {
        await soundRef.current?.pauseAsync();
        setPlaying(false);
        return;
      }
      if (!(await ensureSound())) return;
      await soundRef.current!.setRateAsync(speed, true);
      await soundRef.current!.playAsync();
      setCurrentlyPlayingVoice(msg.id);
      setPlaying(true);
    } catch {}
  }, [playing, ensureSound, speed, msg.id, setCurrentlyPlayingVoice]);

  // Tap anywhere on the waveform → seek there and start playing
  const handleSeek = useCallback(async (locationX: number) => {
    try {
      const w = waveWidthRef.current;
      if (w === 0) return;
      const fraction = Math.max(0, Math.min(1, locationX / w));

      if (!(await ensureSound())) return;

      const st = await soundRef.current!.getStatusAsync();
      if (!st.isLoaded) return;

      const durMs = (st.durationMillis ?? 0) || (totalSecs * 1000);
      if (durMs === 0) return;

      // Optimistic UI — snap the progress bar instantly
      setProgress(fraction);
      setElapsed(fraction * totalSecs);

      await soundRef.current!.setPositionAsync(Math.floor(fraction * durMs));
      await soundRef.current!.setRateAsync(speed, true);
      await soundRef.current!.playAsync();
      setCurrentlyPlayingVoice(msg.id);
      setPlaying(true);
    } catch {}
  }, [ensureSound, speed, totalSecs, msg.id, setCurrentlyPlayingVoice]);

  const cycleSpeed = useCallback(async () => {
    const idx  = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    if (soundRef.current && playing) {
      await soundRef.current.setRateAsync(next, true).catch(() => {});
    }
  }, [speed, playing]);

  const remaining = totalSecs - elapsed;

  return (
    <View style={[styles.container, isOwn ? styles.own : styles.other]}>

      {/* Play / Pause */}
      <Pressable
        onPress={handlePlayPause}
        hitSlop={8}
        style={[styles.playBtn, isOwn ? styles.playBtnOwn : styles.playBtnOther]}
      >
        <Ionicons
          name={playing ? 'pause' : 'play'}
          size={16}
          color={isOwn ? colors.primary[500] : colors.neutral[0]}
        />
      </Pressable>

      {/* Waveform + timer — tap anywhere to seek */}
      <Pressable
        style={styles.middle}
        onLayout={(e) => { waveWidthRef.current = e.nativeEvent.layout.width; }}
        onPress={(e) => handleSeek(e.nativeEvent.locationX)}
        hitSlop={4}
      >
        <WaveformBars
          samples={msg.voice_waveform ?? []}
          progress={progress}
          isOwn={isOwn}
        />
        <Text style={[styles.timer, isOwn ? styles.timerOwn : styles.timerOther]}>
          {playing ? fmt(remaining) : fmt(totalSecs)}
        </Text>
      </Pressable>

      {/* Speed toggle — only visible during playback */}
      {playing && (
        <Pressable onPress={cycleSpeed} hitSlop={8} style={styles.speedBtn}>
          <Text style={[styles.speedText, isOwn ? styles.speedOwn : styles.speedOther]}>
            {speed === 1 ? '1×' : `${speed}×`}
          </Text>
        </Pressable>
      )}

    </View>
  );
}

// ─── Live waveform for the recorder ──────────────────────────────────────────

export function LiveWaveformBars({ samples }: { samples: number[] }) {
  const recent = samples.slice(-BAR_COUNT);
  const padded = recent.length < BAR_COUNT
    ? [...Array(BAR_COUNT - recent.length).fill(0.08), ...recent]
    : recent;

  return (
    <View style={styles.barsRow}>
      {padded.map((amp, i) => (
        <View
          key={i}
          style={{
            width: BAR_W,
            height: BAR_MIN_H + amp * (BAR_MAX_H - BAR_MIN_H),
            borderRadius: 2,
            backgroundColor: colors.primary[500],
            opacity: 0.4 + 0.6 * (i / BAR_COUNT),
          }}
        />
      ))}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
    minWidth: 140,
    maxWidth: 220,
  },
  own:   {},
  other: {},

  playBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  playBtnOwn:   { backgroundColor: 'rgba(255,255,255,0.22)' },
  playBtnOther: { backgroundColor: colors.primary[500] },

  middle: { flex: 1, gap: 4 },

  barsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR_GAP,
    height: BAR_MAX_H + 4,
    overflow: 'hidden',
  },

  timer: { fontSize: 11 },
  timerOwn:   { color: 'rgba(255,255,255,0.75)' },
  timerOther: { color: colors.neutral[500] },

  speedBtn: { paddingHorizontal: 2 },
  speedText: { fontSize: 12, fontWeight: '700' },
  speedOwn:   { color: 'rgba(255,255,255,0.8)' },
  speedOther: { color: colors.primary[500] },
});
