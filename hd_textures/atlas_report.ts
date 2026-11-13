// NOT ORIGINAL - the atlases of the game's levels as atlas.ts finds them (base.ts upscales them region by region).
//
//   node tools/pipeline/hd_textures/atlas_report.ts --game <folder> [--levels BO,AU,foun] [--out <folder>] [--spots <plan.json> [--count 4]]
//
// prints every dictionary's atlases (their regions, and what the old seam heuristic - base.detectAtlas - said of the
// same textures) and, with --out, a picture of each atlas with its regions outlined (<out>\<file>-<checksum>.png);
// --spots writes a plan for compare_models.ts --shots: per level, the `count` atlases with the most regions, the camera
// in front of the biggest mesh using each (its box's middle, along its mean vertex normal).

import * as fs from "node:fs";
import * as path from "node:path";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import { readTex } from "thug2-level-converter-core/level_port/tex.ts";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { encodePng } from "thug2-level-converter-core/lib/frame_diff.ts";
import { cameraAt, findRegions, type MeshSpot, meshSpots, outlinePicture, sceneFiles, UvIndexes } from "./atlas.ts";
import * as base from "./base.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const args = [...argv];
    const take = (name: string): string | undefined => {
        const at = args.indexOf(name);
        if (at < 0) return undefined;
        const value = args[at + 1];
        args.splice(at, 2);
        return value;
    };
    const game = take("--game");
    if (!game) exitWith("usage: atlas_report.ts --game <folder> [--levels BO,AU,foun] [--out <folder>]");
    const levels = take("--levels");
    const out = take("--out");
    const spotsFile = take("--spots");
    const count = Number(take("--count") ?? "4");
    // the atlases of each level (not its sky): checksum -> regions, dictionary
    const ofLevel = new Map<string, Map<number, { regions: number; rel: string }>>();
    const root = base.gameRoot(game);
    const entries = base.collect(root, "levels", levels ? levels.split(",") : null);
    const indexes = new UvIndexes();
    if (out) fs.mkdirSync(out, { recursive: true });
    let atlases = 0;
    let heuristic = 0;
    let unreferenced = 0;
    for (const e of entries) {
        const tex = readTex(base.originalBytes(root, e), e.rel);
        const { index, errors } = indexes.of(path.join(root, e.rel));
        for (const err of errors) print(`  ${e.rel}: scene not read: ${err}`);
        for (const t of tex.textures) {
            if (!base.handledTexture(t)) continue;
            const bgra = hd.topLevel(t);
            const old = base.detectAtlas(bgra, t.width, t.height);
            if (old) heuristic++;
            const found = findRegions(index.get(t.checksum) ?? [], bgra, t.width, t.height);
            const name = `${e.rel} ${t.checksum.toString(16).padStart(8, "0")} ${t.width}x${t.height}`;
            if (found.kind === "unreferenced") {
                unreferenced++;
                print(`${name}: no mesh uses it${old ? ` (heuristic: atlas, ${old})` : ""}`);
                continue;
            }
            if (found.kind === "whole") {
                if (old) print(`${name}: not an atlas - ${found.why} (heuristic said: ${old})`);
                continue;
            }
            atlases++;
            if (!ofLevel.has(e.level)) ofLevel.set(e.level, new Map());
            ofLevel.get(e.level)!.set(t.checksum, { regions: found.regions.length, rel: e.rel });
            const list = found.regions
                .map((r) => `${r.x0},${r.y0}-${r.x1},${r.y1}${r.wrapU ? " wu" : ""}${r.wrapV ? " wv" : ""}`)
                .join("; ");
            print(
                `${name}: ${found.regions.length} regions [${list}]${old ? ` (heuristic: ${old})` : " (heuristic: none)"}`,
            );
            if (out) {
                const file = `${path.basename(e.rel).replace(/\.tex\.xbx$/i, "")}-${t.checksum.toString(16).padStart(8, "0")}.png`;
                fs.writeFileSync(
                    path.join(out, file),
                    encodePng(outlinePicture(bgra, t.width, t.height, found.regions)),
                );
            }
        }
    }
    print(`atlases by uv: ${atlases}; by the seam heuristic: ${heuristic}; textures no mesh uses: ${unreferenced}`);
    if (spotsFile) {
        // a plan for compare_models.ts --shots: each level's atlases with the most regions, seen on their biggest mesh
        const groups: { name: string; level: string; spots: { name: string; commands: string[] }[] }[] = [];
        for (const level of levels ? levels.split(",") : [...ofLevel.keys()]) {
            const found = ofLevel.get(level.toLowerCase());
            if (!found) continue;
            const spots = new Map<number, MeshSpot>();
            for (const rel of new Set([...found.values()].map((f) => f.rel)))
                for (const file of sceneFiles(path.join(root, rel)))
                    meshSpots(scn.readScene(fs.readFileSync(file), file), new Set(found.keys()), spots);
            const picked = [...found]
                .filter(([checksum]) => spots.has(checksum))
                .sort((a, b) => b[1].regions - a[1].regions || spots.get(b[0])!.size - spots.get(a[0])!.size)
                .slice(0, count);
            groups.push({
                name: `${level}-atlas`,
                level,
                spots: picked.map(([checksum]) => ({
                    name: `${level}-atlas-${checksum.toString(16).padStart(8, "0")}`,
                    commands: [cameraAt(spots.get(checksum)!), "wait 90"],
                })),
            });
        }
        fs.writeFileSync(
            spotsFile,
            `${JSON.stringify({ _about: "atlas.ts --spots: atlases seen on their meshes", groups }, null, 2)}\n`,
        );
        print(`${spotsFile}: ${groups.reduce((n, g) => n + g.spots.length, 0)} spots`);
    }
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
