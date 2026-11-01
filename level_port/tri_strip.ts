// NOT ORIGINAL - a triangle list as one strip (moved from thps2_levels.ts with the converters' split; thps3_levels.ts
// had the same function, and Project 8's converter, thp8/thp8_levels.ts, uses it).

export function trisToStrip(tris: readonly (readonly number[])[]): number[] {
    // A triangle list as one strip, the triangles joined by degenerate ones (each starts at an even index, so its
    // turning order is kept) - as tools/pipeline/thps3_levels' trisToStrip. The join is last, last, a, a (a once more when the
    // triangle would start at an odd index): every triangle between two real ones has a corner twice. (Until
    // 2026-10-22 a was pushed once when the parity allowed it, which left (last, a, b) a real triangle: drawn over the
    // next face's first triangle with the previous face's material - z-fighting the user saw, ~1 join in 2.)
    const s: number[] = [];
    for (const [a, b, c] of tris as [number, number, number][]) {
        if (s.length) {
            s.push(s[s.length - 1]!, a, a);
            if ((s.length - 1) % 2) s.push(a);
            s.push(b, c);
        } else {
            s.push(a, b, c);
        }
    }
    return s;
}
