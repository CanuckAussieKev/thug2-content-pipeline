// NOT ORIGINAL - prop packs on a retail THUG2 install (retail/retail_export.ts): the pieces the level editor placed in
// THUG2's own levels (its layouts' `prop` records, with the `sector` / `clone` records of the packs' sectors) baked
// at their places into one scene per level, <L>_Props, which the level then loads beside its own:
//
//   Data\levels\<L>_Props\<L>_Props.scn.xbx / .tex.xbx / .col.xbx   the placed pieces (a name no archive has: the game
//                                                                  reads the loose files)
//   scripts\game\levels.qb (in qb_scripts.prx)                     two insertions (script_merge.ts takes them out
//                                                                  again): props_scene="<L>_Props" in the level's
//                                                                  structure, and in load_level, after the level's
//                                                                  collision, LoadScene / LoadCollision of it.
//
// LoadScene and LoadCollision are the original game's commands (skies use the first); every scene's collision is
// walked by the game's collision tests, so the pieces are solid. Their grind rails - the rail points the editor added
// in the level (the layout's `point` records) - are appended to the level's node array (retail_rails.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { checksum } from "thug2-level-converter-core/level_port/qb.ts";
import { readTex, type Texture, writeTex } from "thug2-level-converter-core/level_port/tex.ts";
import { type ColFile, type ColObject, readCol, writeCol } from "thug2-level-converter-core/level_port/thug2_col.ts";
import {
    type Material,
    readScene,
    type Scene,
    type Sector,
    writeScene,
} from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { hex8 } from "thug2-level-converter-core/lib/text.ts";
import type { Insertion } from "../retail/script_merge.ts";
import { MergeError } from "../retail/script_merge.ts";
import {
    cloneCollision,
    cloneSector,
    levelsOf,
    type Placement,
    placeCollision,
    placeSector,
    readManifest,
} from "./pack.ts";
import { type RailPoint, readLayoutRails } from "./retail_rails.ts";

export const LAYOUTS_FOLDER = "thug2-decomp-layouts";
export const PROPS_FOLDER = "thug2-decomp-props";
export const PROPS_KEY = "props_scene";

export interface LayoutProps {
    scene: number;
    packs: string[];
    sectors: Map<number, { placement: Placement; hidden: boolean }>;
    clones: { source: number; placement: Placement }[];
}

function parseScale(word: string | undefined): { x: number; y: number; z: number } {
    if (!word?.startsWith("scale=")) return { x: 1, y: 1, z: 1 };
    const v = word.slice(6).split(",").map(Number);
    return v.length === 3 ? { x: v[0]!, y: v[1]!, z: v[2]! } : { x: v[0]!, y: v[0]!, z: v[0]! };
}

// A layout's text: its scene, its packs and the sector / clone records (src/editor/level_editor_layout.h).
export function readLayoutProps(text: string): LayoutProps {
    const out: LayoutProps = { scene: 0, packs: [], sectors: new Map(), clones: [] };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.split("#")[0]!.trim();
        const w = line.split(/\s+/);
        if (w[0] === "scene" && w[1]) out.scene = Number.parseInt(w[1], 16) >>> 0;
        else if (w[0] === "prop" && w[1]) {
            if (!out.packs.includes(w[1])) out.packs.push(w[1]);
        } else if (w[0] === "sector" && w.length >= 7) {
            out.sectors.set(Number.parseInt(w[1]!, 16) >>> 0, {
                placement: {
                    quarters: Number(w[2]) & 3,
                    offset: { x: Number(w[3]), y: Number(w[4]), z: Number(w[5]) },
                    scale: parseScale(w.find((x) => x.startsWith("scale="))),
                },
                hidden: w[6] === "1",
            });
        } else if (w[0] === "clone" && w.length >= 6) {
            out.clones.push({
                source: Number.parseInt(w[1]!, 16) >>> 0,
                placement: {
                    quarters: Number(w[2]) & 3,
                    offset: { x: Number(w[3]), y: Number(w[4]), z: Number(w[5]) },
                    scale: parseScale(w.find((x) => x.startsWith("scale="))),
                },
            });
        }
    }
    return out;
}

export interface PackFiles {
    id: string;
    scene: Scene;
    col: ColFile;
    tex: Texture[];
    rails: number;
}

export function readPack(from: string, id: string): PackFiles | null {
    const dir = path.join(from, PROPS_FOLDER, "levels", id);
    const file = (suffix: string) => path.join(dir, `${id}${suffix}`);
    if (![".scn.xbx", ".col.xbx", ".tex.xbx", ".txt"].every((s) => fs.existsSync(file(s)))) return null;
    return {
        id,
        scene: readScene(fs.readFileSync(file(".scn.xbx")), `${id}.scn.xbx`),
        col: readCol(fs.readFileSync(file(".col.xbx")), `${id}.col.xbx`),
        tex: readTex(fs.readFileSync(file(".tex.xbx")), `${id}.tex.xbx`).textures,
        rails: readManifest(fs.readFileSync(file(".txt"), "utf8")).rails.length,
    };
}

export interface BakedProps {
    level: string; // THUG2's level folder (BO)
    scene: string; // <L>_Props
    files: { path: string; data: Buffer }[]; // relative to the game folder, "/"-separated
    pieces: number;
    rails: number; // the packs' rail points
    railPoints: RailPoint[]; // the rail points the editor added in the level (the packs' among them): its node array
    missing: string[]; // packs the layout names that aren't in the props folder
}

export function propsScene(level: string): string {
    return `${level}_Props`;
}

// One level's placed pieces baked into its props scene (null: none placed).
export function bakeLevel(from: string, level: string, layout: LayoutProps): BakedProps | null {
    const scene = propsScene(level);
    const sectors: Sector[] = [];
    const objects: ColObject[] = [];
    const materials = new Map<number, Material>();
    const textures = new Map<number, Texture>();
    const missing: string[] = [];
    let versions: Scene | null = null;
    let colBase: ColFile | null = null;
    let rails = 0;
    let made = 0;
    const place = (pack: PackFiles, source: Sector, p: Placement, name: number) => {
        const sector = cloneSector(source, name);
        placeSector(sector, p);
        sectors.push(sector);
        const own = pack.col.objects.find((o) => o.checksum === source.checksum);
        if (own) {
            const coll = cloneCollision(own, name);
            placeCollision(coll, p);
            objects.push(coll);
        }
        for (const m of sector.meshes) {
            const material = pack.scene.materials.find((x) => x.checksum === m.material);
            if (material) materials.set(material.checksum, material);
        }
    };
    for (const id of layout.packs) {
        const pack = readPack(from, id);
        if (!pack) {
            missing.push(id);
            continue;
        }
        versions ??= pack.scene;
        colBase ??= pack.col;
        let used = false;
        for (const source of pack.scene.sectors) {
            const record = layout.sectors.get(source.checksum);
            if (record && !record.hidden) {
                place(pack, source, record.placement, source.checksum);
                used = true;
                made += 1;
            }
            layout.clones
                .filter((c) => c.source === source.checksum)
                .forEach((c, k) => {
                    place(pack, source, c.placement, checksum(`${hex8(source.checksum)}_copy${k + 1}`));
                    used = true;
                    made += 1;
                });
        }
        if (used) {
            for (const t of pack.tex) textures.set(t.checksum, t);
            rails += pack.rails;
        }
    }
    if (!sectors.length || !versions || !colBase) return missing.length ? emptyResult(level, missing) : null;
    const out: Scene = {
        ...versions,
        materials: [...materials.values()],
        sectors,
        hierarchyCount: 0,
        tail: Buffer.alloc(0),
    };
    const col: ColFile = { ...colBase, objects };
    const dir = `Data/levels/${scene}`;
    return {
        level,
        scene,
        files: [
            { path: `${dir}/${scene}.scn.xbx`, data: writeScene(out) },
            { path: `${dir}/${scene}.tex.xbx`, data: writeTex({ version: 1, textures: [...textures.values()] }) },
            { path: `${dir}/${scene}.col.xbx`, data: writeCol(col) },
        ],
        pieces: made,
        rails,
        railPoints: [],
        missing,
    };
}

function emptyResult(level: string, missing: string[]): BakedProps {
    return { level, scene: propsScene(level), files: [], pieces: 0, rails: 0, railPoints: [], missing };
}

// Every THUG2 level of `game` with pieces placed or rail points added by a layout in `from` (the editor's game
// folder).
export function plan(from: string, game: string): BakedProps[] {
    const folder = path.join(from, LAYOUTS_FOLDER);
    if (!fs.existsSync(folder)) return [];
    const levels = new Map(levelsOf(game).map((l) => [checksum(l), l]));
    const out: BakedProps[] = [];
    for (const name of fs.readdirSync(folder).sort()) {
        if (!/^[0-9a-f]{8}\.txt$/i.test(name)) continue;
        const text = fs.readFileSync(path.join(folder, name), "utf8");
        const layout = readLayoutProps(text);
        const railPoints = readLayoutRails(text);
        if (!layout.packs.length && !railPoints.length) continue;
        const level = levels.get(layout.scene || Number.parseInt(name.slice(0, 8), 16) >>> 0);
        if (!level) continue; // (a converted level's layout: not THUG2's own - its props come with it later)
        const baked = bakeLevel(from, level, layout) ?? emptyResult(level, []);
        baked.railPoints = railPoints;
        if (baked.files.length || baked.missing.length || railPoints.length) out.push(baked);
    }
    return out;
}

// --- Levels.qb ------------------------------------------------------------------------------------------------------

export const HOOK = [
    `    if gotparam ${PROPS_KEY} {`,
    `        LoadScene scene=<${PROPS_KEY}> `,
    `        LoadCollision scene=<${PROPS_KEY}> `,
    "    } ",
];

// The insertions into Levels.qb's text (as NeverScript decompiles it) for the levels with props: the load_level hook
// once (before its `change ParseNodeArrayIgnoreGaps=0`, after the level's collision is loaded) and each level's key.
export function levelsQbInsertions(text: string, levels: readonly string[]): Insertion[] {
    if (!levels.length) return [];
    const out: Insertion[] = [];
    const script = text.search(/(^|\n)script load_level\b/i);
    if (script < 0) throw new MergeError("levels.qb: no load_level script");
    const anchor = text.indexOf("change ParseNodeArrayIgnoreGaps=0", script);
    if (anchor < 0) throw new MergeError("levels.qb: load_level has no `change ParseNodeArrayIgnoreGaps=0`");
    if (text.slice(script, anchor).includes(`gotparam ${PROPS_KEY}`))
        throw new MergeError(`levels.qb: load_level already loads ${PROPS_KEY}`);
    out.push({ at: text.lastIndexOf("\n", anchor) + 1, text: `${HOOK.join("\n")}\n` });
    for (const level of levels) {
        const re = new RegExp(`(^|\\n)Level_${level} = \\{\\n`, "i");
        const m = re.exec(text);
        if (!m) throw new MergeError(`levels.qb: no Level_${level} structure`);
        const at = m.index + m[0].length;
        const end = text.indexOf("\n}", at);
        if (text.slice(at, end).includes(`${PROPS_KEY}=`))
            throw new MergeError(`levels.qb: Level_${level} already has ${PROPS_KEY}`);
        out.push({ at, text: `    ${PROPS_KEY}="${propsScene(level)}" \n` });
    }
    return out;
}
