// NOT ORIGINAL - redraws the level select's globe tiles (Levelselect.prx map0..map21, 64 x 64 painted art) from real
// map data in the original's cartoon style: Natural Earth land (public domain, fetch.ts) mapped through the fitted
// projection (fit.ts / projection.json: a warp of lon / lat that lands every coast where the original art has it, so
// THUG2's level stars still sit on the right places), simplified and smoothed, then painted in the original's own
// flat colours - a dark outline (two shades), a bright green rim, the body in low-poly patches of three greens -
// on its ocean blue. Drawn as one 2048 x 1024 strip (x4), supersampled 3 x 3 for the anti-aliasing, and cut into the
// 22 tiles of level_map_pieces, so every tile border and the horizontal wrap are seamless.
//
//   node tools/pipeline/hd_textures/globe/redraw.ts <out folder> [--scale 4] [--detail 110|50]   (writes strip.png + tiles)

import * as fs from "node:fs";
import * as path from "node:path";
import { encodePng } from "../../game/frame_diff.ts";
import { parseCli } from "../../lib/cli.ts";
import { isMain, print, runMain } from "../../lib/py.ts";
import { loadProjection } from "./fit.ts";
import { loadLakes, loadLand, type Polygon } from "./geo.ts";
import { distanceTo, fillMask, type PixelPolygon, ringAreaXY, simplifyRing, smoothRing, type XY } from "./raster.ts";
import { COLUMNS, LAYOUT, MAP_H, MAP_W, ROWS, TILE, TILE_COUNT } from "./tiles.ts";
import { mapPoint, type Warp } from "./warp.ts";

type Rgb = readonly [number, number, number];
// The original tiles' own colours (sampled from map1..map21; ocean = map0)
export const PALETTE = {
    ocean: [0x42, 0x6c, 0xc1],
    outer: [0x03, 0x5b, 0x02],
    outline: [0x03, 0x77, 0x03],
    rim: [0x04, 0xb4, 0x04],
    rimBright: [0x04, 0xc3, 0x05],
    bodyLight: [0x03, 0xaa, 0x09],
    bodyMid: [0x03, 0x9c, 0x07],
    bodyDark: [0x03, 0x91, 0x07],
} as const satisfies Record<string, Rgb>;

export interface RedrawOptions {
    scale: number; // 4 -> 256 px tiles
    supersample: number; // samples per output pixel side
    detail: 110 | 50;
    minIsland: number; // smallest land piece drawn (1x px^2)
    minHole: number; // smallest bay / lake cut out (1x px^2)
    minLake: number; // smallest lake cut out of the land (1x px^2)
    simplify: number; // Douglas-Peucker tolerance (1x px)
    smooth: number; // Chaikin rounds
    grow: number; // the outline's outer edge outside the coast polygon (1x px)
}

export function defaultRedraw(): RedrawOptions {
    return {
        scale: 4,
        supersample: 3,
        detail: 110,
        minIsland: 2.2,
        minHole: 3,
        minLake: 40,
        simplify: 0.22,
        smooth: 2,
        grow: 0.8,
    };
}

// the land as pixel polygons of the 1x strip: small pieces dropped, rings simplified and rounded
export function shapes(land: readonly Polygon[], warp: Warp, o: RedrawOptions): PixelPolygon[] {
    const out: PixelPolygon[] = [];
    for (const poly of land) {
        const rings = poly.map((r) => r.map((p): XY => mapPoint(warp, p[0], p[1])));
        if (ringAreaXY(rings[0]!) < o.minIsland) continue;
        const kept = rings.filter((ring, i) => i === 0 || ringAreaXY(ring) >= o.minHole);
        out.push(kept.map((ring) => smoothRing(simplifyRing(ring, o.simplify), o.smooth)));
    }
    return out;
}

const hash = (a: number, b: number, c: number): number => {
    let h =
        Math.imul(a + 0x9e3779b1, 0x85ebca6b) ^
        Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^
        Math.imul(c + 0x1234567, 0x27d4eb2f);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
};

// The body's patches: a jittered triangle mesh over the strip (periodic in x), each triangle one of three greens - the
// original's large light / dark facets. Painted into a tone map (0 light, 1 mid, 2 dark) of w x h samples.
const MESH_COLUMNS = 11;
const MESH_ROWS = 5;
function toneMap(w: number, h: number): Uint8Array {
    const tone = new Uint8Array(w * h);
    const cw = MAP_W / MESH_COLUMNS;
    const ch = MAP_H / MESH_ROWS;
    const vertex = (i: number, j: number): XY => {
        const ii = ((i % MESH_COLUMNS) + MESH_COLUMNS) % MESH_COLUMNS;
        const wrapShift = (i - ii) * cw;
        return [
            (ii + 0.5 + (hash(ii, j, 1) - 0.5) * 0.7) * cw + wrapShift,
            (j + (j === 0 || j === MESH_ROWS ? 0 : (hash(ii, j, 2) - 0.5) * 0.7)) * ch,
        ];
    };
    const k = w / MAP_W;
    const triangle = (a: XY, b: XY, c: XY, value: number): void => {
        const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * k));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * k));
        const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * k));
        const y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * k));
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        for (const shift of [-w, 0, w]) {
            for (let y = y0; y <= y1; y++)
                for (let x = x0; x <= x1; x++) {
                    const px = (x + 0.5 - shift) / k;
                    const py = (y + 0.5) / k;
                    const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
                    const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
                    if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) {
                        const sx = x + shift;
                        if (sx >= 0 && sx < w) tone[y * w + sx] = value;
                    }
                }
        }
    };
    const pick = (i: number, j: number, n: number): number => {
        const r = hash(((i % MESH_COLUMNS) + MESH_COLUMNS) % MESH_COLUMNS, j, 10 + n);
        return r < 0.45 ? 0 : r < 0.72 ? 1 : 2;
    };
    for (let j = -1; j <= MESH_ROWS; j++)
        for (let i = -1; i <= MESH_COLUMNS; i++) {
            const p00 = vertex(i, j);
            const p10 = vertex(i + 1, j);
            const p01 = vertex(i, j + 1);
            const p11 = vertex(i + 1, j + 1);
            if (hash(((i % MESH_COLUMNS) + MESH_COLUMNS) % MESH_COLUMNS, j, 3) < 0.5) {
                triangle(p00, p10, p11, pick(i, j, 0));
                triangle(p00, p11, p01, pick(i, j, 1));
            } else {
                triangle(p00, p10, p01, pick(i, j, 0));
                triangle(p10, p11, p01, pick(i, j, 1));
            }
        }
    return tone;
}

// The strip: (MAP_W * scale) x (MAP_H * scale) BGRA.
export function renderStrip(warp: Warp, o: RedrawOptions = defaultRedraw()): Buffer {
    const land = loadLand(o.detail);
    const lakes = loadLakes(o.detail);
    const ss = o.supersample;
    const u = o.scale * ss; // samples per 1x pixel
    const w = MAP_W * u;
    const h = MAP_H * u;
    const toSamples = (polys: readonly PixelPolygon[]): PixelPolygon[] =>
        polys.map((poly) => poly.map((ring) => ring.map((p): XY => [p[0] * u, p[1] * u])));
    const mask = fillMask(toSamples(shapes(land, warp, o)), w, h);
    const lakePolys: PixelPolygon[] = [];
    for (const poly of lakes) {
        const rings = poly.map((r) => r.map((p): XY => mapPoint(warp, p[0], p[1])));
        if (ringAreaXY(rings[0]!) >= o.minLake)
            lakePolys.push(rings.map((r) => smoothRing(simplifyRing(r, o.simplify), o.smooth)));
    }
    if (lakePolys.length) {
        const lake = fillMask(toSamples(lakePolys), w, h);
        for (let i = 0; i < mask.length; i++) if (lake[i]) mask[i] = 0;
    }
    // the cells the game draws as the plain ocean tile (map0) stay ocean
    for (let c = 0; c < COLUMNS; c++)
        for (let r = 0; r < ROWS; r++)
            if (LAYOUT[c]![r] === 0)
                for (let y = r * TILE * u; y < (r + 1) * TILE * u; y++)
                    mask.fill(0, y * w + c * TILE * u, y * w + (c + 1) * TILE * u);
    const ocean = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) ocean[i] = mask[i] ? 0 : 1;
    const din = distanceTo(ocean, w, h); // inside the land: to the nearest ocean sample
    const dout = distanceTo(mask, w, h); // outside: to the nearest land sample
    const tone = toneMap(w, h);
    const bodies: Rgb[] = [PALETTE.bodyLight, PALETTE.bodyMid, PALETTE.bodyDark];
    const growSamples = o.grow * u;
    const colourAt = (i: number): Rgb => {
        const t = mask[i] ? din[i]! - 0.5 + growSamples : growSamples - (dout[i]! - 0.5);
        if (t < 0) return PALETTE.ocean;
        const b = t / u; // 1x pixels from the outline's outer edge
        if (b < 1) return PALETTE.outer;
        if (b < 2) return PALETTE.outline;
        if (b < 3) return PALETTE.rim;
        if (b < 4) return PALETTE.rimBright;
        if (b < 6) return PALETTE.rim;
        return bodies[tone[i]!]!;
    };
    const ow = MAP_W * o.scale;
    const oh = MAP_H * o.scale;
    const out = Buffer.alloc(ow * oh * 4);
    for (let y = 0; y < oh; y++)
        for (let x = 0; x < ow; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            // (the plain-ocean cells stay exactly the ocean: no outline spills in from the next cell)
            const plain = LAYOUT[Math.floor(x / (TILE * o.scale))]![Math.floor(y / (TILE * o.scale))] === 0;
            for (let sy = 0; sy < ss; sy++)
                for (let sx = 0; sx < ss; sx++) {
                    const c = plain ? PALETTE.ocean : colourAt((y * ss + sy) * w + x * ss + sx);
                    r += c[0];
                    g += c[1];
                    b += c[2];
                }
            const n = ss * ss;
            const o4 = (y * ow + x) * 4;
            out[o4] = Math.round(b / n);
            out[o4 + 1] = Math.round(g / n);
            out[o4 + 2] = Math.round(r / n);
            out[o4 + 3] = 255;
        }
    return out;
}

// The 22 tiles (tile * scale square BGRA) of a strip.
export function cutTiles(strip: Buffer, scale: number): Buffer[] {
    const size = TILE * scale;
    const w = MAP_W * scale;
    const tiles: Buffer[] = new Array<Buffer>(TILE_COUNT);
    for (let c = 0; c < COLUMNS; c++)
        for (let r = 0; r < ROWS; r++) {
            const n = LAYOUT[c]![r]!;
            if (tiles[n]) continue; // (map0 is every empty cell: the same ocean)
            const t = Buffer.alloc(size * size * 4);
            for (let y = 0; y < size; y++)
                strip.copy(
                    t,
                    y * size * 4,
                    ((r * size + y) * w + c * size) * 4,
                    ((r * size + y) * w + (c + 1) * size) * 4,
                );
            tiles[n] = t;
        }
    return tiles;
}

// The redrawn tiles (BGRA, TILE * scale square) by number.
export function redrawnTiles(scale = 4, o: Partial<RedrawOptions> = {}, warp: Warp = loadProjection()): Buffer[] {
    return cutTiles(renderStrip(warp, { ...defaultRedraw(), ...o, scale }), scale);
}

export function bgraToPng(bgra: Buffer, w: number, h: number): Buffer {
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
        rgb[i * 3] = bgra[i * 4 + 2]!;
        rgb[i * 3 + 1] = bgra[i * 4 + 1]!;
        rgb[i * 3 + 2] = bgra[i * 4]!;
    }
    return encodePng({ width: w, height: h, rgb });
}

const USAGE = "usage: redraw.ts <out folder> [--scale 4] [--detail 110|50]";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: {
            scale: { type: "string", default: "4" },
            detail: { type: "string", default: "110" },
        },
        allowPositionals: true,
    });
    if (positionals.length !== 1) {
        print(USAGE);
        return 2;
    }
    const scale = Number(values.scale);
    const detail = Number(values.detail) === 50 ? 50 : 110;
    fs.mkdirSync(positionals[0]!, { recursive: true });
    const strip = renderStrip(loadProjection(), {
        ...defaultRedraw(),
        scale,
        detail,
    });
    fs.writeFileSync(path.join(positionals[0]!, "strip.png"), bgraToPng(strip, MAP_W * scale, MAP_H * scale));
    print(`wrote ${path.join(positionals[0]!, "strip.png")}`);
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
