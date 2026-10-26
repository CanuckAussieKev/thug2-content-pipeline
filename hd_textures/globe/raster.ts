// NOT ORIGINAL - the globe redraw's small raster toolbox: polygon fill into a binary mask (even-odd per polygon, the
// polygons OR-ed, repeated one strip to the left and right for the horizontal wrap), a Euclidean distance transform
// (Felzenszwalb & Huttenlocher), ring simplification (Douglas-Peucker) and smoothing (Chaikin).

export type XY = readonly [number, number];

// Rings of one polygon in pixel space (outer ring + holes).
export type PixelPolygon = readonly (readonly XY[])[];

// A w x h mask of the polygons: a pixel is set when its centre is inside. `wrap` also draws every polygon moved by
// -w and +w (the strip's horizontal wrap).
export function fillMask(polygons: readonly PixelPolygon[], w: number, h: number, wrap = true): Uint8Array {
    const mask = new Uint8Array(w * h);
    const shifts = wrap ? [-w, 0, w] : [0];
    const xs: number[] = [];
    for (const poly of polygons) {
        let minY = Infinity;
        let maxY = -Infinity;
        for (const ring of poly)
            for (const p of ring) {
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
            }
        const y0 = Math.max(0, Math.floor(minY - 0.5));
        const y1 = Math.min(h - 1, Math.ceil(maxY - 0.5));
        for (const dx of shifts) {
            for (let y = y0; y <= y1; y++) {
                const yc = y + 0.5;
                xs.length = 0;
                for (const ring of poly) {
                    for (let i = 0, n = ring.length; i < n; i++) {
                        const a = ring[i]!;
                        const b = ring[(i + 1) % n]!;
                        if (a[1] <= yc !== b[1] <= yc)
                            xs.push(a[0] + dx + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
                    }
                }
                if (xs.length < 2) continue;
                xs.sort((p, q) => p - q);
                for (let k = 0; k + 1 < xs.length; k += 2) {
                    const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
                    const to = Math.min(w - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
                    mask.fill(1, y * w + from, y * w + to + 1);
                }
            }
        }
    }
    return mask;
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
        let s: number;
        for (;;) {
            const p = v[k]!;
            s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
            if (s <= z[k]!) k--;
            else break;
            if (k < 0) {
                k = 0;
                break;
            }
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1]! < q) k++;
        const p = v[k]!;
        d[q] = (q - p) * (q - p) + f[p]!;
    }
}

// For each pixel the distance to the nearest set pixel of `mask` (0 on them), in pixels, wrapping horizontally
// (a copy of the strip on either side is not needed: the columns are padded by `pad` pixels on both sides, the
// distances beyond which are not exact - callers need a few pixels only).
export function distanceTo(mask: Uint8Array, w: number, h: number, wrapX = true): Float32Array {
    const BIG = 1e10;
    const f = new Float64Array(Math.max(w, h));
    const d = new Float64Array(Math.max(w, h));
    const v = new Int32Array(Math.max(w, h));
    const z = new Float64Array(Math.max(w, h) + 1);
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = mask[i] ? 0 : BIG;
    // columns
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) f[y] = out[y * w + x]!;
        edt1d(f, h, d, v, z);
        for (let y = 0; y < h; y++) out[y * w + x] = d[y]!;
    }
    // rows (for the wrap, three copies of the row: the middle one is read out)
    const row = new Float64Array(w * 3);
    const rd = new Float64Array(w * 3);
    const rv = new Int32Array(w * 3);
    const rz = new Float64Array(w * 3 + 1);
    for (let y = 0; y < h; y++) {
        if (wrapX) {
            for (let c = 0; c < 3; c++) for (let x = 0; x < w; x++) row[c * w + x] = out[y * w + x]!;
            edt1d(row, w * 3, rd, rv, rz);
            for (let x = 0; x < w; x++) out[y * w + x] = rd[w + x]!;
        } else {
            for (let x = 0; x < w; x++) f[x] = out[y * w + x]!;
            edt1d(f, w, d, v, z);
            for (let x = 0; x < w; x++) out[y * w + x] = d[x]!;
        }
    }
    for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(out[i]!);
    return out;
}

function perpendicular(p: XY, a: XY, b: XY): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

// Douglas-Peucker on a closed ring.
export function simplifyRing(ring: readonly XY[], tolerance: number): XY[] {
    if (ring.length < 4) return [...ring];
    // split the ring at its two farthest-apart anchor points (the first and the one farthest from it)
    let far = 0;
    let best = -1;
    for (let i = 1; i < ring.length; i++) {
        const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]);
        if (d > best) {
            best = d;
            far = i;
        }
    }
    const dp = (pts: readonly XY[]): XY[] => {
        if (pts.length < 3) return [...pts];
        let idx = 0;
        let m = -1;
        for (let i = 1; i < pts.length - 1; i++) {
            const d = perpendicular(pts[i]!, pts[0]!, pts[pts.length - 1]!);
            if (d > m) {
                m = d;
                idx = i;
            }
        }
        if (m <= tolerance) return [pts[0]!, pts[pts.length - 1]!];
        const l = dp(pts.slice(0, idx + 1));
        const r = dp(pts.slice(idx));
        return [...l.slice(0, -1), ...r];
    };
    const first = dp(ring.slice(0, far + 1));
    const second = dp([...ring.slice(far), ring[0]!]);
    return [...first.slice(0, -1), ...second.slice(0, -1)];
}

// Chaikin corner cutting on a closed ring.
export function smoothRing(ring: readonly XY[], iterations: number): XY[] {
    let pts: XY[] = [...ring];
    for (let it = 0; it < iterations; it++) {
        const next: XY[] = [];
        for (let i = 0, n = pts.length; i < n; i++) {
            const a = pts[i]!;
            const b = pts[(i + 1) % n]!;
            next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
            next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
        }
        pts = next;
    }
    return pts;
}

export function ringAreaXY(ring: readonly XY[]): number {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
}
