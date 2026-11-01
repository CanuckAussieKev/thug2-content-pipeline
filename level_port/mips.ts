// NOT ORIGINAL - mip levels of a 32-bit texture (moved from thps3_levels.ts with the converters' split: the THPS2
// converter makes its mip chains so too).

export function mipDown(level: Buffer, w: number, h: number): Buffer {
    // The next mip level of a 32-bit texture: each 2 x 2 block averaged (a 1-wide side halves the other only).
    const nw = Math.max(1, Math.floor(w / 2));
    const nh = Math.max(1, Math.floor(h / 2));
    const sx = w > 1 ? 2 : 1;
    const sy = h > 1 ? 2 : 1;
    const out = Buffer.alloc(nw * nh * 4);
    const row = w * 4;
    for (let y = 0; y < nh; y++) {
        const r0 = y * sy * row;
        const r1 = r0 + (sy === 2 ? row : 0);
        let o = y * nw * 4;
        for (let x = 0; x < nw; x++) {
            const c0 = r0 + x * sx * 4;
            const c1 = c0 + (sx === 2 ? 4 : 0);
            const d0 = r1 + x * sx * 4;
            const d1 = d0 + (sx === 2 ? 4 : 0);
            for (let k = 0; k < 4; k++) {
                out[o + k] = (level[c0 + k]! + level[c1 + k]! + level[d0 + k]! + level[d1 + k]! + 2) >> 2;
            }
            o += 4;
        }
    }
    return out;
}
