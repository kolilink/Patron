#!/usr/bin/env python3
"""Deterministic synthesis of Patron's two notification chimes.

    python3 scripts/audio/generate_chimes.py            # write masters + platform files
    python3 scripts/audio/generate_chimes.py --wav-only # masters only (no afconvert/ffmpeg)
    python3 scripts/audio/generate_chimes.py --out DIR  # write somewhere else (used by the determinism test)

Outputs (all committed, byte-identical on every re-run):
    assets/sounds/patron_chime.wav          44.1 kHz 16-bit mono master
    assets/sounds/patron_chime_urgent.wav
    assets/sounds/ios/patron_chime.caf      iOS  (afconvert, LEI16 — lossless)
    assets/sounds/ios/patron_chime_urgent.caf
    assets/sounds/android/patron_chime.ogg  Android res/raw (ffmpeg, Opus-in-Ogg, bitexact;
                                            plays on Android 5.0+, Expo SDK 54 needs 7.0+)
    assets/sounds/android/patron_chime_urgent.ogg

Voice: a woody, balafon-inspired pluck.
    y(t) = sin(2*pi*f*t)*exp(-t/0.45)
         + 0.3 * sin(4*pi*f*t)*exp(-3t/0.45)
         + 0.1 * sin(6*pi*f*t)*exp(-5t/0.45)
5 ms attack, 50 ms fade to silence, peak normalised to -1 dBFS.

DEFAULT  "patron_chime":        A4 (440) -> E5 (659.25)            t = 0, 0.35 s   1.15 s
URGENT   "patron_chime_urgent": A4 -> E5 -> A5 (880)                t = 0, 0.28, 0.56 s  ~1.35 s
         (same voice, slightly brighter: harmonic weights x1.0 / x1.4 / x1.4)
Only numpy + the stdlib are needed for the WAV masters. Nothing here reads the
clock or a random source, so re-running changes no bytes.
"""
import argparse
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
PEAK_DBFS = -1.0
ATTACK_S = 0.005
FADE_S = 0.050
TAU = 0.45

ROOT = Path(__file__).resolve().parents[2]
SOUNDS = ROOT / 'assets' / 'sounds'

A4, E5, A5 = 440.0, 659.25, 880.0

# name -> (notes [(freq, start_s, length_s)], overtone brightness)
CHIMES = {
    'patron_chime': ([(A4, 0.00, 0.55), (E5, 0.35, 0.80)], 1.0),
    'patron_chime_urgent': ([(A4, 0.00, 0.55), (E5, 0.28, 0.55), (A5, 0.56, 0.79)], 1.4),
}


def note(freq: float, length_s: float, bright: float) -> np.ndarray:
    n = int(round(length_s * SR))
    t = np.arange(n, dtype=np.float64) / SR
    y = (np.sin(2 * np.pi * freq * t) * np.exp(-t / TAU)
         + 0.3 * bright * np.sin(4 * np.pi * freq * t) * np.exp(-3 * t / TAU)
         + 0.1 * bright * np.sin(6 * np.pi * freq * t) * np.exp(-5 * t / TAU))
    attack = int(round(ATTACK_S * SR))
    env = np.ones(n)
    env[:attack] = np.linspace(0.0, 1.0, attack, endpoint=False)
    fade = int(round(FADE_S * SR))
    env[n - fade:] *= np.linspace(1.0, 0.0, fade)   # each note ends in silence
    return y * env


def render(notes, bright: float) -> np.ndarray:
    total = max(start + length for _, start, length in notes)
    out = np.zeros(int(round(total * SR)), dtype=np.float64)
    for freq, start, length in notes:
        s = int(round(start * SR))
        voice = note(freq, length, bright)
        out[s:s + len(voice)] += voice
    out /= np.max(np.abs(out))
    out *= 10 ** (PEAK_DBFS / 20)
    fade = int(round(FADE_S * SR))
    out[-fade:] *= np.linspace(1.0, 0.0, fade)       # 50 ms fade to silence
    out[-1] = 0.0
    return out


def write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = np.clip(np.round(samples * 32767.0), -32768, 32767).astype('<i2')
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--wav-only', action='store_true')
    ap.add_argument('--out', type=Path, default=SOUNDS)
    args = ap.parse_args()
    out = args.out.resolve()

    for name, (notes, bright) in CHIMES.items():
        wav = out / f'{name}.wav'
        write_wav(wav, render(notes, bright))
        print(f'wrote {wav}')
        if args.wav_only:
            continue
        caf = out / 'ios' / f'{name}.caf'
        ogg = out / 'android' / f'{name}.ogg'
        caf.parent.mkdir(parents=True, exist_ok=True)
        ogg.parent.mkdir(parents=True, exist_ok=True)
        if shutil.which('afconvert'):
            run(['afconvert', '-f', 'caff', '-d', 'LEI16@44100', '-c', '1', str(wav), str(caf)])
            print(f'wrote {caf}')
        else:
            print('afconvert not found (macOS only) — kept the committed .caf', file=sys.stderr)
        if shutil.which('ffmpeg'):
            run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(wav),
                 '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
                 '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', str(ogg)])
            print(f'wrote {ogg}')
        else:
            print('ffmpeg not found — kept the committed .ogg', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
