// supabase/functions/invite/lib.ts
//
// Pure, Deno-free logic for the DYNAMIC invite Open Graph image. No Deno
// imports, no network, no env access: this module is unit-tested by ts-jest
// (__tests__/invite-og.test.ts) and imported by index.ts.
//
// The edge runtime has no native image stack, so the card is drawn from a
// generated 8x8 bitmap font (font.ts) and encoded to PNG with a tiny,
// dependency-free truecolor encoder (deflate via the platform's
// CompressionStream + a hand-rolled CRC32). Deterministic: same input →
// byte-identical output.
//
// Display name is resolved at link-generation time and snapshotted onto the
// invite (inviter_name). The card bakes the title "[Nom] t'invite sur Patron"
// — or "Ton ami t'invite sur Patron" when no personal name is set — directly
// INTO the pixels, not only into og:title. Any failure must fall back to the
// static branded PNG (see renderOrFallback), never a broken image.

import { FONT, FONT_WIDTH, FONT_HEIGHT, FALLBACK_GLYPH } from './font.ts';

export const FALLBACK_NAME = 'Ton ami';
export const DEFAULT_TITLE = "On t'invite sur Patron";
export const TAGLINE = 'Tes ventes, tes crédits — même sans internet.';
export const FOOTER = 'Gratuit · Fait pour les commerçants';

export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 630;

// Patron purple, matching scripts/generate-invite-og.py (the static card).
const PURPLE: readonly [number, number, number] = [99, 102, 241]; // #6366F1
const PURPLE_DARK: readonly [number, number, number] = [79, 70, 229]; // #4F46E5
const WHITE: readonly [number, number, number] = [255, 255, 255];
const WHITE_SOFT: readonly [number, number, number] = [224, 228, 255];

// ─────────────────────────────────────────────────────────────────────────
// Display-name rule — the single source of truth for the title string.
// ─────────────────────────────────────────────────────────────────────────
export function titleFor(valid: boolean, name: string | null): string {
    if (!valid) return DEFAULT_TITLE;
    const n = name && name.trim() ? name.trim() : FALLBACK_NAME;
    return `${n} t'invite sur Patron`;
}

// ─────────────────────────────────────────────────────────────────────────
// Text rendering (fixed-width 8x8 glyphs, scaled).
// ─────────────────────────────────────────────────────────────────────────
export function measureText(text: string, scale: number): number {
    return text.length * FONT_WIDTH * scale;
}

function drawText(
    rgb: Uint8Array,
    width: number,
    x: number,
    y: number,
    text: string,
    scale: number,
    color: readonly [number, number, number],
): void {
    const [r, g, b] = color;
    let cursor = x;
    for (const ch of text) {
        const glyph = FONT[ch] ?? FALLBACK_GLYPH;
        for (let row = 0; row < FONT_HEIGHT; row++) {
            const bits = glyph[row];
            for (let col = 0; col < FONT_WIDTH; col++) {
                if ((bits & (0x80 >> col)) === 0) continue;
                const px = cursor + col * scale;
                const py = y + row * scale;
                for (let dy = 0; dy < scale; dy++) {
                    let off = (py + dy) * width + px;
                    for (let dx = 0; dx < scale; dx++) {
                        rgb[off * 3] = r;
                        rgb[off * 3 + 1] = g;
                        rgb[off * 3 + 2] = b;
                        off++;
                    }
                }
            }
        }
        cursor += FONT_WIDTH * scale;
    }
}

// Split a string into lines so none exceeds maxChars (per line), keeping word
// boundaries where possible and hard-breaking any word longer than maxChars.
function wrapWords(text: string, maxChars: number): string[] {
    if (maxChars < 1) return [text];
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        if (current === '') {
            current = word;
        } else if (current.length + 1 + word.length <= maxChars) {
            current += ' ' + word;
        } else {
            lines.push(current);
            current = word;
        }
        // Hard-break an over-long single word.
        while (current.length > maxChars) {
            lines.push(current.slice(0, maxChars));
            current = current.slice(maxChars);
        }
    }
    if (current !== '') lines.push(current);
    return lines;
}

interface TitleLayout {
    lines: string[];
    scale: number;
}

// Layout the title so it fits the card: prefer one line at the largest scale,
// otherwise wrap to at most two lines at a smaller scale, finally truncating
// (never overflowing the canvas).
function layoutTitle(valid: boolean, name: string | null): TitleLayout {
    const title = titleFor(valid, name);
    const maxWidth = IMAGE_WIDTH - 80; // 40px side margins
    const maxScale = 6; // 48px glyphs
    const minScale = 3; // 24px glyphs

    for (let scale = maxScale; scale >= minScale; scale--) {
        if (measureText(title, scale) <= maxWidth) {
            return { lines: [title], scale };
        }
    }

    for (let scale = maxScale; scale >= minScale; scale--) {
        const maxChars = Math.floor(maxWidth / (FONT_WIDTH * scale));
        const lines = wrapWords(title, maxChars);
        if (lines.length <= 2) {
            return { lines: lines.slice(0, 2), scale };
        }
    }

    // Extreme fallback: force two lines at the minimum scale, truncating the
    // last line with an ellipsis so the card can never overflow.
    const maxChars = Math.floor(maxWidth / (FONT_WIDTH * minScale));
    const lines = wrapWords(title, maxChars).slice(0, 2);
    if (lines.length === 2 && lines[1].length === maxChars) {
        lines[1] = lines[1].slice(0, maxChars - 1) + '…';
    }
    return { lines, scale: minScale };
}

// ─────────────────────────────────────────────────────────────────────────
// Card bitmap (1200x630, RGB) — the whole visual, name baked in.
// ─────────────────────────────────────────────────────────────────────────
export function buildCardBitmap(
    name: string | null,
    valid: boolean,
): { width: number; height: number; rgb: Uint8Array } {
    const width = IMAGE_WIDTH;
    const height = IMAGE_HEIGHT;
    const rgb = new Uint8Array(width * height * 3);

    // Background.
    for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = PURPLE[0];
        rgb[i * 3 + 1] = PURPLE[1];
        rgb[i * 3 + 2] = PURPLE[2];
    }
    // Left accent band.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < 14; x++) {
            const i = (y * width + x) * 3;
            rgb[i] = PURPLE_DARK[0];
            rgb[i + 1] = PURPLE_DARK[1];
            rgb[i + 2] = PURPLE_DARK[2];
        }
    }

    const centerX = (text: string, scale: number): number =>
        Math.round((width - measureText(text, scale)) / 2);

    // Wordmark.
    const wordmark = 'PATRON';
    const wordmarkScale = 3;
    drawText(rgb, width, centerX(wordmark, wordmarkScale), 64, wordmark, wordmarkScale, WHITE);

    // Title (the inviter's name, rendered into the visual).
    const title = layoutTitle(valid, name);
    if (title.lines.length === 1) {
        drawText(rgb, width, centerX(title.lines[0], title.scale), 210, title.lines[0], title.scale, WHITE);
    } else {
        drawText(rgb, width, centerX(title.lines[0], title.scale), 170, title.lines[0], title.scale, WHITE);
        const line2Y = 170 + FONT_HEIGHT * title.scale + 22;
        drawText(rgb, width, centerX(title.lines[1], title.scale), line2Y, title.lines[1], title.scale, WHITE);
    }

    // Tagline + footer.
    const taglineScale = 2;
    drawText(rgb, width, centerX(TAGLINE, taglineScale), 430, TAGLINE, taglineScale, WHITE_SOFT);
    drawText(rgb, width, centerX(FOOTER, taglineScale), 530, FOOTER, taglineScale, WHITE_SOFT);

    return { width, height, rgb };
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal truecolor PNG encoder (8-bit, filter 0, deflate via CompressionStream).
// ─────────────────────────────────────────────────────────────────────────
const CRC_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const readPromise = (async () => {
        const chunks: Uint8Array[] = [];
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
        }
        return chunks;
    })();
    // Copy into a fresh ArrayBuffer: the DOM's CompressionStream writer expects
    // a BufferSource backed by an ArrayBuffer (not ArrayBufferLike/Shared).
    await writer.write(new Uint8Array(raw));
    await writer.close();
    const chunks = await readPromise;

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
        out.set(c, p);
        p += c.length;
    }
    return out;
}

export async function encodePng(rgb: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    // Scanlines: 1 filter byte (0) + width*3 bytes.
    const raw = new Uint8Array(height * (1 + width * 3));
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0;
        const rowStart = y * width * 3;
        raw.set(rgb.subarray(rowStart, rowStart + width * 3), o);
        o += width * 3;
    }

    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor RGB
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const idat = await deflate(raw);
    const parts = [
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', new Uint8Array(0)),
    ];
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

// Full dynamic image: name + valid → PNG bytes (deterministic).
export async function renderOgImage(name: string | null, valid: boolean): Promise<Uint8Array> {
    const { width, height, rgb } = buildCardBitmap(name, valid);
    return encodePng(rgb, width, height);
}

// Silent fallback contract: never a broken image, never an error. Returns the
// dynamic image on success, the static branded PNG on failure, or null only
// when there is no static asset at all (index.ts then serves 404 — the only
// path with no fallback, which cannot happen in a deployed function because
// og.png ships beside this file).
export async function renderOrFallback(
    dynamic: () => Promise<Uint8Array>,
    staticPng: Uint8Array | null,
): Promise<Uint8Array | null> {
    try {
        return await dynamic();
    } catch {
        return staticPng;
    }
}
