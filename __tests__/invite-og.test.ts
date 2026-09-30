// supabase/functions/invite/lib.ts — the dynamic invite OG card.
//
// Real oracle: these tests DECODE the generated PNG (via Node's zlib) and
// verify the inviter's display name is baked into the actual pixels, using an
// independent renderer that reads only the glyph data (font.ts) — not the
// lib's own drawText. They also prove the "Ton ami" fallback, the silent
// static fallback on failure (the HTTP 200 path: index.ts serves any non-null
// bytes with status 200), and the <300KB weight budget.
import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { join } from 'path';

import {
    IMAGE_HEIGHT,
    IMAGE_WIDTH,
    buildCardBitmap,
    encodePng,
    layoutTitle,
    measureText,
    renderOgImage,
    renderOrFallback,
    titleFor,
} from '../supabase/functions/invite/lib';
import { FONT, FONT_WIDTH, FONT_HEIGHT } from '../supabase/functions/invite/font';

// ─── Independent PNG decoder (no lib helpers) ────────────────────────────
interface DecodedPng {
    width: number;
    height: number;
    rgb: Uint8Array;
}

function decodePng(bytes: Uint8Array): DecodedPng {
    // PNG signature.
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    let offset = 8;
    let width = 0;
    let height = 0;
    const idatParts: Uint8Array[] = [];

    while (offset < bytes.length) {
        const len = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const data = bytes.subarray(offset + 8, offset + 8 + len);
        if (type === 'IHDR') {
            width = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
            height = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0);
        } else if (type === 'IDAT') {
            idatParts.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + len; // len + type + data + crc
    }

    expect(width).toBe(IMAGE_WIDTH);
    expect(height).toBe(IMAGE_HEIGHT);

    const total = idatParts.reduce((s, p) => s + p.length, 0);
    const z = new Uint8Array(total);
    let p = 0;
    for (const part of idatParts) {
        z.set(part, p);
        p += part.length;
    }
    const raw = new Uint8Array(inflateSync(z));

    // Reconstruct RGB, removing the filter byte (0 = None) from each scanline.
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    const stride = width * 3;
    for (let y = 0; y < height; y++) {
        const filter = raw[src++];
        expect(filter).toBe(0);
        rgb.set(raw.subarray(src, src + stride), dst);
        src += stride;
        dst += stride;
    }
    return { width, height, rgb };
}

// ─── Independent glyph renderer (reads font.ts data only) ────────────────
const MAX_WIDTH = IMAGE_WIDTH - 80;
const MAX_SCALE = 6;
const MIN_SCALE = 3;
const TITLE_Y = 210;

function expectedTitleScale(text: string): number {
    for (let scale = MAX_SCALE; scale >= MIN_SCALE; scale--) {
        if (text.length * FONT_WIDTH * scale <= MAX_WIDTH) return scale;
    }
    return MIN_SCALE;
}

function glyphSet(ch: string): boolean[][] {
    const glyph = FONT[ch] ?? FONT['\uFFFD'];
    return Array.from({ length: FONT_HEIGHT }, (_, row) =>
        Array.from({ length: FONT_WIDTH }, (_, col) => (glyph[row] & (0x80 >> col)) !== 0),
    );
}

function titleLinePixelMap(text: string, scale: number, y: number): Map<string, true> {
    const totalW = text.length * FONT_WIDTH * scale;
    const x0 = Math.round((IMAGE_WIDTH - totalW) / 2);
    const map = new Map<string, true>();
    for (let i = 0; i < text.length; i++) {
        const glyph = glyphSet(text[i]);
        for (let row = 0; row < FONT_HEIGHT; row++) {
            for (let col = 0; col < FONT_WIDTH; col++) {
                if (!glyph[row][col]) continue;
                const px = x0 + i * FONT_WIDTH * scale + col * scale;
                const py = y + row * scale;
                for (let dy = 0; dy < scale; dy++) {
                    for (let dx = 0; dx < scale; dx++) {
                        map.set(`${px + dx},${py + dy}`, true);
                    }
                }
            }
        }
    }
    return map;
}

function titlePixelMap(text: string, scale: number): Map<string, true> {
    return titleLinePixelMap(text, scale, TITLE_Y);
}

// Pixels for a single character at index within a single-line title.
function titleCharPixelMap(text: string, charIndex: number, scale: number, y: number): Map<string, true> {
    const totalW = text.length * FONT_WIDTH * scale;
    const x0 = Math.round((IMAGE_WIDTH - totalW) / 2);
    const map = new Map<string, true>();
    const glyph = glyphSet(text[charIndex]);
    for (let row = 0; row < FONT_HEIGHT; row++) {
        for (let col = 0; col < FONT_WIDTH; col++) {
            if (!glyph[row][col]) continue;
            const px = x0 + charIndex * FONT_WIDTH * scale + col * scale;
            const py = y + row * scale;
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    map.set(`${px + dx},${py + dy}`, true);
                }
            }
        }
    }
    return map;
}

function isWhite(rgb: Uint8Array, width: number, x: number, y: number): boolean {
    const i = (y * width + x) * 3;
    return rgb[i] === 255 && rgb[i + 1] === 255 && rgb[i + 2] === 255;
}

// ─── Tests ───────────────────────────────────────────────────────────────
describe('titleFor — display name resolved at link-generation', () => {
    it('uses the personal name when set', () => {
        expect(titleFor(true, 'Awa')).toBe("Awa t'invite sur Patron");
    });

    it('falls back to "Ton ami" when no name', () => {
        expect(titleFor(true, null)).toBe("Ton ami t'invite sur Patron");
        expect(titleFor(true, '   ')).toBe("Ton ami t'invite sur Patron");
    });

    it('uses the default title for an invalid link', () => {
        expect(titleFor(false, 'Awa')).toBe("On t'invite sur Patron");
    });
});

describe('dynamic OG image — name baked into the visual', () => {
    it('renders the inviter name into the actual pixels', async () => {
        const png = await renderOgImage('Awa', true);
        expect(png.length).toBeLessThan(300 * 1024);

        const { rgb, width } = decodePng(png);
        const title = "Awa t'invite sur Patron";
        const scale = expectedTitleScale(title);
        expect(scale).toBe(MAX_SCALE); // 23 chars * 8 * 6 = 1104 ≤ 1120

        // Every pixel of the title must be white — the name IS in the visual.
        const map = titlePixelMap(title, scale);
        expect(map.size).toBeGreaterThan(0);
        for (const key of map.keys()) {
            const [x, y] = key.split(',').map(Number);
            expect(isWhite(rgb, width, x, y)).toBe(true);
        }
    });

    it('renders "Ton ami" when the inviter has no name', async () => {
        const png = await renderOgImage(null, true);
        expect(png.length).toBeLessThan(300 * 1024);

        const { rgb, width } = decodePng(png);
        const title = "Ton ami t'invite sur Patron";
        const scale = expectedTitleScale(title);
        expect(scale).toBe(5); // 27 chars * 8 * 6 = 1296 > 1120 → wraps down to scale 5

        const map = titlePixelMap(title, scale);
        expect(map.size).toBeGreaterThan(0);
        for (const key of map.keys()) {
            const [x, y] = key.split(',').map(Number);
            expect(isWhite(rgb, width, x, y)).toBe(true);
        }
    });

    it('produces a different image for a named inviter vs the fallback', async () => {
        const named = await renderOgImage('Awa', true);
        const fallback = await renderOgImage(null, true);
        expect(Buffer.from(named).equals(Buffer.from(fallback))).toBe(false);
    });

    it('keeps the PNG under 300KB for a long name too', async () => {
        const png = await renderOgImage('Abdoulaye Mamadou Diarra', true);
        expect(png.length).toBeLessThan(300 * 1024);
        expect(decodePng(png).width).toBe(IMAGE_WIDTH);
    });

    it('renders every French accented character as non-empty pixels (never tofu)', async () => {
        // "Sékou" and "Aïcha Cissé" exercise é, ï, ç — the requested coverage
        // probe. The glyphs are non-empty AND distinct from the hollow
        // FALLBACK_GLYPH (the tofu box), so an accent is never rendered as □.
        const ACCENTED = new Set([
            'é', 'è', 'ê', 'ë', 'à', 'â', 'ç', 'î', 'ï', 'ô', 'û', 'ù', 'ü', 'œ',
            'É', 'È', 'Ê', 'Ë', 'À', 'Â', 'Ç', 'Î', 'Ï', 'Ô', 'Û', 'Ù', 'Ü',
        ]);

        for (const name of ['Sékou', 'Aïcha Cissé']) {
            const title = titleFor(true, name);
            const scale = expectedTitleScale(title);

            // The layout must fit on one line: both titles are short enough.
            expect(layoutTitle(true, name).lines).toEqual([title]);

            const png = await renderOgImage(name, true);
            expect(png.length).toBeLessThan(300 * 1024);
            const { rgb, width } = decodePng(png);

            const accented = [...title].filter(ch => ACCENTED.has(ch));
            expect(accented.length).toBeGreaterThan(0);

            for (const ch of accented) {
                // Glyph itself is non-empty (has at least one lit pixel)…
                const bits = glyphSet(ch);
                expect(bits.some(row => row.some(Boolean))).toBe(true);
                // …and is not the fallback box.
                expect(FONT[ch]).not.toEqual(FONT['\uFFFD']);

                // …and those pixels are actually white in the decoded image.
                const idx = [...title].indexOf(ch);
                const charMap = titleCharPixelMap(title, idx, scale, TITLE_Y);
                expect(charMap.size).toBeGreaterThan(0);
                for (const key of charMap.keys()) {
                    const [x, y] = key.split(',').map(Number);
                    expect(isWhite(rgb, width, x, y)).toBe(true);
                }
            }
        }
    });
});

describe('layoutTitle — long-name wrapping and clean truncation', () => {
    it('wraps a long name onto two lines at a smaller scale', () => {
        // 51-char title: does not fit one line even at minimum scale, so it
        // must wrap to two lines at scale 5 (never overflow, never drop a word).
        const layout = layoutTitle(true, 'Abdoulaye Mamadou Diarra Traoré');
        expect(layout.scale).toBeLessThan(MAX_SCALE);
        expect(layout.lines).toHaveLength(2);
        expect(layout.lines.join(' ')).toBe(titleFor(true, 'Abdoulaye Mamadou Diarra Traoré'));
        for (const line of layout.lines) {
            expect(measureText(line, layout.scale)).toBeLessThanOrEqual(IMAGE_WIDTH - 80);
        }
    });

    it('cleanly truncates an extremely long name with an ellipsis, never overflowing', () => {
        const longName = 'X'.repeat(120) + ' Abdoulaye';
        const layout = layoutTitle(true, longName);

        // Two lines, minimum scale, each line within the canvas…
        expect(layout.lines).toHaveLength(2);
        expect(layout.scale).toBe(MIN_SCALE);
        for (const line of layout.lines) {
            expect(measureText(line, layout.scale)).toBeLessThanOrEqual(IMAGE_WIDTH - 80);
        }

        // …and the cut is visibly signalled with a real ellipsis (U+2026).
        expect(layout.lines[1].endsWith('…')).toBe(true);

        // The ellipsis is actually drawn (non-empty glyph, baked into pixels).
        const png = renderOgImage(longName, true);
        return png.then(bytes => {
            expect(bytes.length).toBeLessThan(300 * 1024);
            const { rgb, width } = decodePng(bytes);
            const secondLineY = 170 + FONT_HEIGHT * layout.scale + 22;
            const ellipsisIdx = layout.lines[1].length - 1;
            const ellMap = titleCharPixelMap(layout.lines[1], ellipsisIdx, layout.scale, secondLineY);
            expect(ellMap.size).toBeGreaterThan(0);
            for (const key of ellMap.keys()) {
                const [x, y] = key.split(',').map(Number);
                expect(isWhite(rgb, width, x, y)).toBe(true);
            }
        });
    });
});

describe('renderOrFallback — silent static fallback, never broken (HTTP 200 path)', () => {
    const staticPng = new Uint8Array(readFileSync(join(__dirname, '..', 'supabase', 'functions', 'invite', 'og.png')));

    it('serves the static brand card when generation fails', async () => {
        const result = await renderOrFallback(
            async () => {
                throw new Error('forced generation failure');
            },
            staticPng,
        );
        // index.ts serves any non-null result with HTTP 200 image/png.
        expect(result).not.toBeNull();
        expect(Buffer.from(result as Uint8Array).equals(Buffer.from(staticPng))).toBe(true);
    });

    it('returns the dynamic image when generation succeeds', async () => {
        const result = await renderOrFallback(
            () => renderOgImage('Awa', true),
            staticPng,
        );
        expect(result).not.toBeNull();
        expect(Buffer.from(result as Uint8Array).equals(Buffer.from(staticPng))).toBe(false);
    });

    it('returns null only when there is no static fallback at all', async () => {
        const result = await renderOrFallback(
            async () => {
                throw new Error('boom');
            },
            null,
        );
        expect(result).toBeNull();
    });

    it('static fallback asset is a valid, in-budget PNG', () => {
        expect(staticPng.length).toBeLessThan(300 * 1024);
        expect([...staticPng.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });
});

describe('buildCardBitmap / encodePng — deterministic and well-formed', () => {
    it('produces byte-identical output for identical input', async () => {
        const a = await renderOgImage('Awa', true);
        const b = await renderOgImage('Awa', true);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });

    it('builds the exact 1200x630 bitmap', () => {
        const { width, height, rgb } = buildCardBitmap('Awa', true);
        expect(width).toBe(IMAGE_WIDTH);
        expect(height).toBe(IMAGE_HEIGHT);
        expect(rgb.length).toBe(IMAGE_WIDTH * IMAGE_HEIGHT * 3);
    });
});
