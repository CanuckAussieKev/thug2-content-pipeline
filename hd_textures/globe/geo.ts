// NOT ORIGINAL - Natural Earth land polygons (public domain, tools/pipeline/hd_textures/globe/fetch.ts) as rings of
// [longitude, latitude], ready to be mapped onto the globe's strip.

import * as fs from "node:fs";
import * as path from "node:path";
import { NE_DIR } from "./fetch.ts";

export type Point = readonly [number, number];
// outer ring first, then holes
export type Polygon = readonly (readonly Point[])[];

interface GeoJson {
    features: { geometry: { type: string; coordinates: unknown } }[];
}

export function parseGeoJson(text: string): Polygon[] {
    const json = JSON.parse(text) as GeoJson;
    const out: Polygon[] = [];
    for (const f of json.features) {
        const g = f.geometry;
        if (g.type === "Polygon") out.push(g.coordinates as Polygon);
        else if (g.type === "MultiPolygon") out.push(...(g.coordinates as Polygon[]));
    }
    return out;
}

export function ringArea(ring: readonly Point[]): number {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

// What the original art leaves out: Antarctica (the strip ends at the southern tip of South America, the bottom row is
// all ocean). The Chukotka piece east of the antimeridian continues Russia past 180 degrees: moved by +360 so the
// strip does not tear Russia in two.
export function prepare(polygons: readonly Polygon[]): Polygon[] {
    const out: Polygon[] = [];
    for (const poly of polygons) {
        const outer = poly[0]!;
        const lats = outer.map((p) => p[1]);
        if (Math.max(...lats) < -60) continue; // Antarctica
        const lons = outer.map((p) => p[0]);
        const shift = Math.min(...lons) <= -179.9 && Math.min(...lats) > 60 ? 360 : 0;
        out.push(shift ? poly.map((ring) => ring.map((p): Point => [p[0] + shift, p[1]])) : poly);
    }
    return out;
}

export function loadLand(detail: 110 | 50 = 110): Polygon[] {
    const file = path.join(NE_DIR, `ne_${detail}m_land.geojson`);
    if (!fs.existsSync(file)) throw new Error(`${file} missing: run node tools/pipeline/hd_textures/globe/fetch.ts`);
    return prepare(parseGeoJson(fs.readFileSync(file, "utf8")));
}

// Lakes big enough to draw (the Caspian Sea and the like), as polygons to cut out of the land.
export function loadLakes(detail: 110 | 50 = 110): Polygon[] {
    const file = path.join(NE_DIR, `ne_${detail}m_lakes.geojson`);
    if (!fs.existsSync(file)) throw new Error(`${file} missing: run node tools/pipeline/hd_textures/globe/fetch.ts`);
    return parseGeoJson(fs.readFileSync(file, "utf8"));
}
