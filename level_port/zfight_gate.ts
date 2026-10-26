// NOT ORIGINAL - z-fight regression gates for the converters' tests: each converted level's z-fight pixels
// (zfight_raster.ts, THUG2's renderer in software) at most what the converter achieved when the gate was set, with a
// small margin.
//
// The levels are read from a staging folder the converter wrote (<game>\thug2-decomp-<port>\levels\<level>), the game
// folder from THUG2_ZFIGHT_GAME (default C:\Games\THUG2\Game, the main install). A level is checked only when its
// scene is the one the converter resolved (zfight_resolve.ts' note, <staging>\zfight\<level>.json, written after the
// scene); without it - no such conversion, or one before z-fighting was resolved - the test is skipped.
//
// The views: GATE_SPOTS skater spots (zfight_raster's ground sampling, seed 1) x 4 headings, rendered on worker
// threads - fewer than the detector's default 300, so that the gates stay quick; the limits were measured with the
// same views. Alternate states (class `states`) aren't counted.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { analyseParallel, buildRasterScene, classOf, levelViews, readLevel, sortedPairs } from "./zfight_raster.ts";
import { noteFile } from "./zfight_resolve.ts";

export const GATE_SPOTS = 100;
export const GATE_HEADINGS = 4;
export const GAME = process.env.THUG2_ZFIGHT_GAME ?? "C:\\Games\\THUG2\\Game";

// The limit for a level from what was measured: a quarter more, and 200 pixels (of 400 views x 320 x 180).
export const limitFrom = (measured: number): number => Math.ceil(measured * 1.25 + 200);

export function levelsFolder(port: string, game = GAME): string {
    return path.join(game, `thug2-decomp-${port}`, "levels");
}

// Whether the staged level is one the converter resolved (its note at least as new as its scene).
export function resolvedLevel(folder: string, level: string): boolean {
    const dir = path.join(folder, level);
    const scn = path.join(dir, `${level}.scn.xbx`);
    const note = noteFile(dir, level);
    if (!fs.existsSync(scn) || !fs.existsSync(note)) return false;
    return fs.statSync(note).mtimeMs >= fs.statSync(scn).mtimeMs;
}

// The z-fight pixels of a staged level, with the gate's views - those between alternate states (class `states`: two
// sectors the scripts show and hide apart, most likely never drawn together) counted apart, not in `fight`.
export async function gatePixels(
    folder: string,
    level: string,
): Promise<{ fight: number; states: number; top: string }> {
    const l = readLevel(folder, level);
    const rs = buildRasterScene(l.scene, { hidden: l.hidden, shared: true });
    const views = levelViews(l, { views: GATE_SPOTS, headings: GATE_HEADINGS, seed: 1 });
    const a = await analyseParallel(rs, views, {}, Math.max(1, os.cpus().length - 1));
    const pairs = sortedPairs(a).filter((s) => classOf(s, rs, l.toggles) !== "states");
    const states = a.fight - pairs.reduce((n, s) => n + s.pixels, 0);
    const top = pairs
        .slice(0, 3)
        .map(
            (s) =>
                `${rs.meshes[s.a]!.sectorChecksum.toString(16)}/${rs.meshes[s.b]!.sectorChecksum.toString(16)} ${s.pixels} px`,
        )
        .join(", ");
    return { fight: a.fight - states, states, top };
}

// One test per level: its z-fight pixels at most its limit.
export function zfightGates(port: string, limits: Readonly<Record<string, number>>): void {
    const folder = levelsFolder(port);
    for (const [level, limit] of Object.entries(limits)) {
        test(`z-fighting gate: ${port} ${level} at most ${limit} pixels`, {
            skip: !resolvedLevel(folder, level),
        }, async () => {
            const { fight, top } = await gatePixels(folder, level);
            assert.ok(fight <= limit, `${level}: ${fight} z-fight pixels (at most ${limit}); top pairs ${top}`);
        });
    }
}
