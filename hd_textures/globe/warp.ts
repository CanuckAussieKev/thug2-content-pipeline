// NOT ORIGINAL - the globe strip's map projection: longitude / latitude -> pixel of the 512 x 256 strip (1x). The
// original is a freehand equirectangular-like world map; the fit (fit.ts) is a polynomial warp of lon / lat, which the
// redraw uses so that every coast lands where the original's art puts it (and THUG2's level stars sit on it).

import type { Point } from "./geo.ts";

// terms: 1, u, v, u^2, uv, v^2, u^3, u^2 v, u v^2, v^3 with u = lon / 180, v = lat / 90
export const TERMS = 10;
export interface Warp {
    x: number[]; // TERMS coefficients
    y: number[];
}

const poly = (c: readonly number[], u: number, v: number): number =>
    c[0]! +
    c[1]! * u +
    c[2]! * v +
    c[3]! * u * u +
    c[4]! * u * v +
    c[5]! * v * v +
    c[6]! * u * u * u +
    c[7]! * u * u * v +
    c[8]! * u * v * v +
    c[9]! * v * v * v;

export function mapPoint(warp: Warp, lon: number, lat: number): [number, number] {
    const u = lon / 180;
    const v = lat / 90;
    return [poly(warp.x, u, v), poly(warp.y, u, v)];
}

export const mapLonLat = (warp: Warp, p: Point): [number, number] => mapPoint(warp, p[0], p[1]);

// The plain affine start: 1.3 px per degree east, 1.42 per degree north.
export function affineStart(): Warp {
    const x = new Array<number>(TERMS).fill(0);
    const y = new Array<number>(TERMS).fill(0);
    x[0] = 78 + 1.3 * 118.24;
    x[1] = 1.3 * 180;
    y[0] = 141;
    y[2] = -1.42 * 90;
    return { x, y };
}
