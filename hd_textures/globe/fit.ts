// NOT ORIGINAL - fits the globe strip's map projection (warp.ts) to the original art: the land of the 512 x 256
// strip (Levelselect.prx's map tiles, tiles.ts) against Natural Earth's coastline, by maximising the overlap of the
// two land masks (a derivative-free pattern search, affine -> quadratic -> cubic terms), with THUG2's own level stars
// (level_select.ts THUG2_STARS: real lon / lat -> where Neversoft put the star on the map) as a second measure.
//
//   node tools/pipeline/hd_textures/globe/fit.ts <game folder> [--out tools/pipeline/hd_textures/globe/projection.json]
//
// projection.json (committed) is what redraw.ts reads: the fit takes a minute, the result is data.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseCli } from "../../lib/cli.ts";
import { resolveInstall } from "../../lib/install.ts";
import { isMain, print, runMain } from "../../lib/py.ts";
import { THUG2_STARS } from "../../menu_level/level_select.ts";
import { loadLand, type Polygon } from "./geo.ts";
import { fillMask, type PixelPolygon } from "./raster.ts";
import { assemble, COLUMNS, LAYOUT, MAP_H, MAP_W, originalTiles, ROWS, TILE } from "./tiles.ts";
import { affineStart, mapPoint, TERMS, type Warp } from "./warp.ts";

export const PROJECTION_FILE = path.join(import.meta.dirname, "projection.json");

// The original's land (everything that is not the ocean's blue), eroded by one pixel: the polygon's edge runs through
// the middle of the painted outline.
export function originalLand(tiles: readonly Buffer[]): Uint8Array {
    const bgra = assemble(tiles);
    const land = new Uint8Array(MAP_W * MAP_H);
    for (let i = 0; i < land.length; i++) land[i] = bgra[i * 4 + 2]! < 0x30 ? 1 : 0;
    const out = new Uint8Array(land.length);
    for (let y = 0; y < MAP_H; y++)
        for (let x = 0; x < MAP_W; x++) {
            const i = y * MAP_W + x;
            if (!land[i]) continue;
            const l = land[y * MAP_W + ((x + MAP_W - 1) % MAP_W)]!;
            const r = land[y * MAP_W + ((x + 1) % MAP_W)]!;
            const u = y > 0 ? land[i - MAP_W]! : 1;
            const d = y < MAP_H - 1 ? land[i + MAP_W]! : 1;
            out[i] = l && r && u && d ? 1 : 0;
        }
    return out;
}

export function landPixels(land: readonly Polygon[], warp: Warp): PixelPolygon[] {
    return land.map((poly) => poly.map((ring) => ring.map((p): [number, number] => mapPoint(warp, p[0], p[1]))));
}

// Land the game cannot show: in the cells that use the plain ocean tile (map0), as a share of the land
export function lostLand(mask: Uint8Array): number {
    let lost = 0;
    let total = 0;
    for (let c = 0; c < COLUMNS; c++)
        for (let r = 0; r < ROWS; r++)
            for (let y = r * TILE; y < (r + 1) * TILE; y++)
                for (let x = c * TILE; x < (c + 1) * TILE; x++)
                    if (mask[y * MAP_W + x]) {
                        total++;
                        if (LAYOUT[c]![r] === 0) lost++;
                    }
    return lost / Math.max(total, 1);
}

export function iou(a: Uint8Array, b: Uint8Array): number {
    let both = 0;
    let either = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] || b[i]) either++;
        if (a[i] && b[i]) both++;
    }
    return both / either;
}

export interface StarError {
    name: string;
    dx: number;
    dy: number;
}

export function starErrors(warp: Warp): StarError[] {
    return [...THUG2_STARS].map(([name, [lon, lat, x, y]]) => {
        const [px, py] = mapPoint(warp, lon, lat);
        return { name, dx: px - x, dy: py - y };
    });
}

const rms = (errs: readonly StarError[]): number =>
    Math.sqrt(errs.reduce((s, e) => s + e.dx * e.dx + e.dy * e.dy, 0) / errs.length);

// Pattern search over the first `terms` coefficients of each polynomial.
export function fitWarp(
    land: readonly Polygon[],
    target: Uint8Array,
    start: Warp = affineStart(),
    log: (s: string) => void = () => {},
): Warp {
    const cost = (w: Warp): number => {
        const m = fillMask(landPixels(land, w), MAP_W, MAP_H, false);
        return 1 - iou(m, target) + 0.004 * rms(starErrors(w)) + 20 * lostLand(m);
    };
    let best: Warp = { x: [...start.x], y: [...start.y] };
    let bestCost = cost(best);
    const stages: { active: number[]; step: number }[] = [
        { active: [0, 1, 2], step: 6 }, // affine
        { active: [0, 1, 2, 3, 4, 5], step: 4 }, // quadratic
        { active: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], step: 3 }, // cubic
    ];
    for (const [si, stage] of stages.entries()) {
        let step = stage.step;
        while (step > 0.05) {
            let improved = false;
            for (const axis of ["x", "y"] as const)
                for (const k of stage.active) {
                    // (the higher terms move the map by about `step` pixels at the edge of the world)
                    for (const dir of [1, -1]) {
                        const trial: Warp = { x: [...best.x], y: [...best.y] };
                        trial[axis][k] = trial[axis][k]! + dir * step;
                        const c = cost(trial);
                        if (c < bestCost - 1e-7) {
                            best = trial;
                            bestCost = c;
                            improved = true;
                        }
                    }
                }
            if (!improved) step /= 2;
        }
        log(`stage ${si + 1}: cost ${bestCost.toFixed(4)}, stars rms ${rms(starErrors(best)).toFixed(1)} px`);
    }
    return best;
}

export function loadProjection(file = PROJECTION_FILE): Warp {
    const w = JSON.parse(fs.readFileSync(file, "utf8")) as Warp;
    if (w.x.length !== TERMS || w.y.length !== TERMS) throw new Error(`${file}: wrong shape`);
    return w;
}

const USAGE = "usage: fit.ts <game folder> [--out file.json]";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: {
            out: { type: "string", default: PROJECTION_FILE },
            refine: { type: "boolean" },
        },
        allowPositionals: true,
    });
    if (positionals.length !== 1) {
        print(USAGE);
        return 2;
    }
    const tiles = originalTiles(resolveInstall(positionals[0]!, "thug2"));
    const target = originalLand(tiles);
    const land = loadLand(110);
    const warp = fitWarp(land, target, values.refine ? loadProjection() : affineStart(), print);
    const mask = fillMask(landPixels(land, warp), MAP_W, MAP_H, false);
    print(
        `land overlap (IoU) ${iou(mask, target).toFixed(3)}, land in plain-ocean cells ${(lostLand(mask) * 100).toFixed(2)} %`,
    );
    for (const e of starErrors(warp)) print(`  star ${e.name}: off by (${e.dx.toFixed(1)}, ${e.dy.toFixed(1)}) px`);
    const rounded: Warp = {
        x: warp.x.map((v) => Math.round(v * 1e4) / 1e4),
        y: warp.y.map((v) => Math.round(v * 1e4) / 1e4),
    };
    fs.writeFileSync(values.out!, JSON.stringify(rounded, null, 2) + "\n");
    print(`wrote ${values.out}`);
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
