// NOT ORIGINAL - the level select's maps of the levels that have no place on Earth (level_select.ts: `location: null`).
// Where such a level used to spin the globe without a star, it now shows a top-down plan of the level itself, drawn from
// its collision (the converted level's .col.xbx, so any game's level the converters made) in the globe's own style
// (tools/pipeline/hd_textures/globe/plan.ts), in the same round window under the same frame, with the star on it.
//
//   - one map per level, named lmap_<level>, a 256 x 256 image (images\LevelSelectSprites, loaded like the signs) and,
//     with --hd-ui, a 1024 x 1024 one in the overlay's hd_ui folder (DXT1: the map is opaque);
//   - THP8's network levels are zones of one town: they share the town's map (net_beavervalley, the whole town:
//     lmap_thp8_town) and each has its star at its zone's place on it. The zone's place: the zone's own collision is the
//     town's, moved - every object the two share is the same object shifted by one offset per zone (the median over the
//     shared ones, checked in the tests against the real files) - so the zone's middle (the area-weighted centre of its
//     floors) plus that offset is where it stands in the town. BEAVER VALLEY itself, the whole town, has its star in
//     the town's middle;
//   - a standalone level's star is at the area-weighted middle of its floors (not its start point: the converted node
//     arrays are not read here);
//   - a level without collision in the staging folder (not converted) keeps the spinning globe.
//
// The script side is level_select.ts: an entry with map_texture=<name> map_pos=(x, y) gets the map instead of the globe.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    defaultPlan,
    fitPlan,
    PLAN_SIZE,
    type PlanFit,
    type PlanTriangles,
    planPoint,
    renderPlan,
} from "../hd_textures/globe/plan.ts";
import { encodeImg } from "../hd_textures/ui.ts";
import {
    type ColFile,
    FACE_DECAL,
    FACE_INVISIBLE,
    FACE_NON_COLLIDABLE,
    FACE_TRIGGER,
    readCol,
} from "../level_port/thug2_col.ts";
import type { Level, Section } from "./level_select.ts";
import { type Colour, writeImg } from "./level_select_icons.ts";

// Faces left out of a footprint: no collision, decals, triggers, invisible walls and kill planes.
const SKIPPED_FACES = FACE_NON_COLLIDABLE | FACE_DECAL | FACE_TRIGGER | FACE_INVISIBLE;

export interface Footprint {
    tris: PlanTriangles;
    // the area-weighted middle of the floors (faces that look up), world x / z
    floor: [number, number];
}

const percentile = (sorted: Float64Array, p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;

// A level's footprint from its collision: every face that collides and is not (nearly) vertical, as triangles seen from
// above; the outliers (far boundaries, kill planes' planes) cut off by the 0.3 / 99.7 percentiles of the faces' middles.
export function footprint(col: ColFile): Footprint {
    const corners: number[] = []; // x0, z0, x1, z1, x2, z2 per face
    const mid: number[] = []; // x, z per face
    const area: number[] = []; // seen from above; negative on a face that is not a floor
    for (const object of col.objects) {
        for (const [flags, , ia, ib, ic] of object.faces) {
            if (flags & SKIPPED_FACES) continue;
            const a = object.verts[ia];
            const b = object.verts[ib];
            const c = object.verts[ic];
            if (!a || !b || !c) continue;
            // the face's normal (y up): ny is twice its area seen from above
            const ux = b[0]! - a[0]!;
            const uy = b[1]! - a[1]!;
            const uz = b[2]! - a[2]!;
            const vx = c[0]! - a[0]!;
            const vy = c[1]! - a[1]!;
            const vz = c[2]! - a[2]!;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            const length = Math.hypot(nx, ny, nz);
            if (length === 0 || Math.abs(ny) / length < 0.2) continue;
            corners.push(a[0]!, a[2]!, b[0]!, b[2]!, c[0]!, c[2]!);
            mid.push((a[0]! + b[0]! + c[0]!) / 3, (a[2]! + b[2]! + c[2]!) / 3);
            area.push(Math.abs(ny) / length > 0.7 ? Math.abs(ny) / 2 : -1);
        }
    }
    const count = area.length;
    const axis = (offset: number): [number, number] => {
        const sorted = new Float64Array(count);
        for (let n = 0; n < count; n++) sorted[n] = mid[n * 2 + offset]!;
        sorted.sort();
        const lo = percentile(sorted, 0.003);
        const hi = percentile(sorted, 0.997);
        const pad = (hi - lo) * 0.03;
        return [lo - pad, hi + pad];
    };
    const [x0, x1] = count ? axis(0) : [0, 0];
    const [z0, z1] = count ? axis(1) : [0, 0];
    const tris: number[] = [];
    let sx = 0;
    let sz = 0;
    let sw = 0;
    for (let n = 0; n < count; n++) {
        const x = mid[n * 2]!;
        const z = mid[n * 2 + 1]!;
        if (x < x0 || x > x1 || z < z0 || z > z1) continue;
        for (let j = 0; j < 6; j++) tris.push(corners[n * 6 + j]!);
        if (area[n]! > 0) {
            sx += x * area[n]!;
            sz += z * area[n]!;
            sw += area[n]!;
        }
    }
    return {
        tris: Float32Array.from(tris),
        floor: sw > 0 ? [sx / sw, sz / sw] : [(x0 + x1) / 2, (z0 + z1) / 2],
    };
}

export function readFootprint(colFile: string): Footprint {
    return footprint(readCol(fs.readFileSync(colFile), path.basename(colFile)));
}

// --- the maps ------------------------------------------------------------------------------------------------------

export const TOWN_FOLDER = "net_beavervalley"; // THP8's whole town (manifest folder)
export const TOWN_TEXTURE = "lmap_thp8_town";
const MIN_SHARED_OBJECTS = 5; // a zone's offset needs this many objects it shares with the town
const PLAN_MIDDLE = 128;
const round1 = (v: number): number => Math.round(v * 10) / 10;

export interface LevelMap {
    texture: string;
    tris: PlanTriangles;
    fit: PlanFit;
    seed: number;
}

// The middle of each collision object's box (x, z), by checksum.
export function objectMiddles(col: ColFile): Map<number, [number, number]> {
    const out = new Map<number, [number, number]>();
    for (const o of col.objects) out.set(o.checksum, [(o.bbox[0]! + o.bbox[4]!) / 2, (o.bbox[2]! + o.bbox[6]!) / 2]);
    return out;
}

// Where a zone stands in the town: the median shift of the objects the two collisions share (null: too few).
export function zoneOffset(
    zone: ReadonlyMap<number, readonly [number, number]>,
    town: ReadonlyMap<number, readonly [number, number]>,
): [number, number] | null {
    const dx: number[] = [];
    const dz: number[] = [];
    for (const [checksum, [x, z]] of zone) {
        const t = town.get(checksum);
        if (!t) continue;
        dx.push(t[0] - x);
        dz.push(t[1] - z);
    }
    if (dx.length < MIN_SHARED_OBJECTS) return null;
    const median = (a: number[]): number => a.sort((p, q) => p - q)[Math.floor(a.length / 2)]!;
    return [median(dx), median(dz)];
}

const colPath = (game: string, lv: Level): string | null => {
    if (!lv.staging || !lv.levelName) return null;
    const file = path.join(game, lv.staging, "levels", lv.levelName, `${lv.levelName}.col.xbx`);
    return fs.existsSync(file) ? file : null;
};

// Gives every level with no place and a converted collision its map (Level.map), the stars of THP8's zones on the
// town's map; returns the maps to draw by texture name. `log` hears the levels left on the globe.
export function attachMaps(
    game: string,
    sectionList: readonly Section[],
    log: (line: string) => void = () => {},
): Map<string, LevelMap> {
    const maps = new Map<string, LevelMap>();
    let seed = 0;
    const own = (texture: string, file: string): { map: LevelMap; floor: [number, number] } => {
        const fp = readFootprint(file);
        const map = { texture, tris: fp.tris, fit: fitPlan(fp.tris), seed: ++seed };
        maps.set(texture, map);
        return { map, floor: fp.floor };
    };
    for (const [, , , levels] of sectionList) {
        const town = (levels ?? []).find((lv) => lv.folder === TOWN_FOLDER && lv.staging === "thug2-decomp-thp8");
        const townFile = town ? colPath(game, town) : null;
        let townCol: ColFile | null = null;
        for (const lv of levels ?? []) {
            if (lv.location !== null) continue;
            const file = colPath(game, lv);
            if (!file) {
                log(`level map: ${lv.text}: no converted collision - the globe`);
                continue;
            }
            const isZone =
                townFile !== null && lv.staging === "thug2-decomp-thp8" && (lv.folder ?? "").startsWith("net_");
            if (isZone) {
                const base = maps.get(TOWN_TEXTURE) ?? own(TOWN_TEXTURE, townFile!).map;
                if (lv === town) {
                    lv.map = { texture: TOWN_TEXTURE, x: PLAN_MIDDLE, y: PLAN_MIDDLE };
                    continue;
                }
                townCol ??= readCol(fs.readFileSync(townFile!), "town");
                const shift = zoneOffset(
                    objectMiddles(readCol(fs.readFileSync(file), lv.text)),
                    objectMiddles(townCol),
                );
                if (!shift) {
                    log(`level map: ${lv.text}: shares too few objects with the town - the globe`);
                    continue;
                }
                const floor = readFootprint(file).floor;
                const [x, y] = planPoint(base.fit, floor[0] + shift[0], floor[1] + shift[1]);
                lv.map = { texture: TOWN_TEXTURE, x: round1(x), y: round1(y) };
            } else {
                const texture = `lmap_${lv.levelName!.toLowerCase()}`;
                const { map, floor } = own(texture, file);
                const [x, y] = planPoint(map.fit, floor[0], floor[1]);
                lv.map = { texture, x: round1(x), y: round1(y) };
            }
        }
    }
    return maps;
}

// The map textures the levels use, sorted.
export function mapTextures(sectionList: readonly Section[]): string[] {
    const names = new Set<string>();
    for (const [, , , levels] of sectionList) for (const lv of levels ?? []) if (lv.map) names.add(lv.map.texture);
    return [...names].sort();
}

// The drawing of a map at a scale (BGRA, 256 * scale square).
export function drawMap(map: LevelMap, scale: number): Buffer {
    return renderPlan(map.tris, map.fit, defaultPlan(scale, map.seed * 17));
}

// A map as the game's own 8-bit image (like the signs, images\LevelSelectSprites\<name>.img.xbx): the 256 most used
// colours of the drawing (the flat greens and blues and their anti-aliased blends - about a hundred in all) as the
// palette, the rest to the nearest.
export function nativeImage(bgra: Buffer, size: number): Buffer {
    const counts = new Map<number, number>();
    for (let i = 0; i < bgra.length; i += 4) {
        const key = (bgra[i]! << 16) | (bgra[i + 1]! << 8) | bgra[i + 2]!;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 255);
    // (the palette's entries are B, G, R, A like the image's texels: ui.ts decodeImg)
    // (index 0 is left unused: a drawing's most used colour there came out transparent in the game)
    const palette: Colour[] = [
        [0, 0, 0, 0xff],
        ...top.map(([key]): Colour => [(key >> 16) & 255, (key >> 8) & 255, key & 255, 0xff]),
    ];
    const cache = new Map<number, number>();
    const indices: number[] = [];
    for (let i = 0; i < bgra.length; i += 4) {
        const key = (bgra[i]! << 16) | (bgra[i + 1]! << 8) | bgra[i + 2]!;
        let at = cache.get(key);
        if (at === undefined) {
            let best = 0;
            let bestDistance = Infinity;
            palette.forEach((c, n) => {
                if (n === 0) return;
                const d = (c[0] - bgra[i]!) ** 2 + (c[1] - bgra[i + 1]!) ** 2 + (c[2] - bgra[i + 2]!) ** 2;
                if (d < bestDistance) {
                    bestDistance = d;
                    best = n;
                }
            });
            at = best;
            cache.set(key, at);
        }
        indices.push(at);
    }
    return writeImg(size, size, palette, indices);
}

// Writes the native images into the overlay; returns the names.
export function writeMaps(overlay: string, maps: ReadonlyMap<string, LevelMap>, used: readonly string[]): string[] {
    const folder = path.join(overlay, "images", "LevelSelectSprites");
    fs.mkdirSync(folder, { recursive: true });
    for (const name of used)
        fs.writeFileSync(path.join(folder, `${name}.img.xbx`), nativeImage(drawMap(maps.get(name)!, 1), PLAN_SIZE));
    return [...used];
}

// The HD images (scale x 256 px, DXT1: the map is opaque) by the overlay's relative name; ui.ts's install puts them in
// the overlay's hd_ui folder in place of upscaling the native ones.
export function hdMapFiles(
    maps: ReadonlyMap<string, LevelMap>,
    used: readonly string[],
    scale: number,
): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const blank = Buffer.alloc(0);
    const original = { tw: PLAN_SIZE, th: PLAN_SIZE, iw: PLAN_SIZE, ih: PLAN_SIZE, bgra: blank };
    for (const name of used)
        out.set(
            path.join("images", "LevelSelectSprites", `${name}.img.xbx`),
            encodeImg(original, drawMap(maps.get(name)!, scale), scale, true),
        );
    return out;
}
