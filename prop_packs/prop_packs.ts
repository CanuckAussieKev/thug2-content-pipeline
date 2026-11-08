// NOT ORIGINAL - prop packs (pack.ts): the level editor's Content Browser runs these with the Node runtime it ships
// (the decomp's src/editor/level_editor_content.h):
//
//   node prop_packs/prop_packs.ts catalogue --game <THUG2> [--out <folder>] [--levels A,B]
//   node prop_packs/prop_packs.ts thumbs --game <THUG2> --level <L> | --all [--out <folder>] [--size N]
//   node prop_packs/prop_packs.ts extract --game <THUG2> --level <L> --piece <name> [--out <folder>]
//   node prop_packs/prop_packs.ts sync [--out <folder>]
//   node prop_packs/prop_packs.ts prefab-thumb --game <THUG2> --prefab <file> [--out <folder>] [--size N]
//
// <THUG2>: the game folder whose Data\levels are read (only read). <out> (default: the game folder): where the packs
// go - <out>\thug2-decomp-props (catalogue.txt, levels\<pack>\, images\props\<level>\) - and, when <out> has the data
// overlay (thug2-decomp-data), copied into it too, where the game reads them (make_menu_level.ts makes the overlay
// again with them: `sync`).
//
//   catalogue  every level's pieces into catalogue.txt (a level kept from the last run while its scene file's size
//              and time are the same). Lines (tab-separated):
//                prop-catalogue 1
//                level <L> <pieces> <scene bytes> <scene time>
//                piece <L> <name> <checksum> <triangles> <textures> <rails> <min x y z> <max x y z>
//              It prints "level <L> <pieces>" as it goes.
//   thumbs     a small picture of each of the level's pieces (thumbnail.ts), images\props\<l>\<checksum>.img.xbx
//              (those there kept while the folder's stamp, thumbs.txt, names this renderer's version and the size);
//              prints "thumb <L> <checksum>" for each one made, then "thumbs <L> <count>". --all: every level's.
//   extract    the piece cut out into a pack (pack.ts makePack); prints "pack <id>" (made again only when its level
//              changed since).
//   sync       the packs and pictures copied into the overlay.
//   prefab-thumb  a level editor prefab's picture (prefabThumb below).

import * as fs from "node:fs";
import * as path from "node:path";
import { readTex, type TexFile } from "thug2-level-converter-core/level_port/tex.ts";
import {
    type Material,
    readScene,
    type Scene,
    type Sector,
} from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { exitWith, isMain, parseCli, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { findCaseless, resolveInstall } from "thug2-level-converter-core/lib/install.ts";
import { hex8 } from "thug2-level-converter-core/lib/text.ts";
import { nativeImg } from "../menu_level/loading_art.ts";
import {
    cloneSector,
    levelDir,
    levelsOf,
    MANIFEST_VERSION,
    makePack,
    packId,
    piecesOf,
    placeSector,
    readLevel,
    writePack,
} from "./pack.ts";
import { readLayoutProps } from "./retail_props.ts";
import { TextureSet, THUMB_VERSION, thumbnail } from "./thumbnail.ts";

const USAGE =
    "usage: prop_packs.ts catalogue|thumbs|extract|prefab-thumb|sync --game THUG2 [--out FOLDER] [--level L | --all] [--levels A,B] [--piece NAME] [--prefab FILE] [--size N]";

export const PROPS_FOLDER = "thug2-decomp-props";
export const OVERLAY = "thug2-decomp-data";
export const CATALOGUE = "catalogue.txt";
const THUMB_SIZE = 64;
// (a level's pictures folder: the renderer's version and the size its pictures were drawn with - not copied into the
// overlay)
const THUMB_STAMP = "thumbs.txt";

function sceneStamp(game: string, level: string): { bytes: number; time: number } {
    const dir = levelDir(game, level);
    const file = findCaseless(dir, `${path.basename(dir)}.scn.xbx`);
    const stat = file ? fs.statSync(file) : null;
    return { bytes: stat?.size ?? 0, time: Math.floor(stat?.mtimeMs ?? 0) };
}

const f = (v: number) => String(Math.round(v * 10) / 10);

export function catalogue(game: string, out: string, only: readonly string[] | null): void {
    const folder = path.join(out, PROPS_FOLDER);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, CATALOGUE);
    const old = new Map<string, { head: string; pieces: string[] }>();
    if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
            const w = line.split("\t");
            if (w[0] === "level") old.set(w[1]!.toLowerCase(), { head: line, pieces: [] });
            else if (w[0] === "piece") old.get(w[1]!.toLowerCase())?.pieces.push(line);
        }
    }
    const lines = ["prop-catalogue\t1"];
    for (const level of levelsOf(game)) {
        const stamp = sceneStamp(game, level);
        const kept = old.get(level.toLowerCase());
        const wanted = !only || only.some((l) => l.toLowerCase() === level.toLowerCase());
        const same = kept?.head.split("\t").slice(3, 5).join("\t") === `${stamp.bytes}\t${stamp.time}`;
        if (kept && (same || !wanted)) {
            lines.push(kept.head, ...kept.pieces);
            print(`level ${level} ${kept.pieces.length}`);
            continue;
        }
        if (!wanted) continue;
        let data: ReturnType<typeof readLevel>;
        try {
            data = readLevel(game, level, false);
        } catch (err) {
            print(`skipped ${level}: ${(err as Error).message}`);
            continue;
        }
        const pieces = piecesOf(data);
        lines.push(["level", level, pieces.length, stamp.bytes, stamp.time].join("\t"));
        for (const p of pieces)
            lines.push(
                [
                    "piece",
                    level,
                    p.name,
                    hex8(p.checksum).toLowerCase(),
                    p.triangles,
                    p.textures.length,
                    p.rails.length,
                    f(p.box.min.x),
                    f(p.box.min.y),
                    f(p.box.min.z),
                    f(p.box.max.x),
                    f(p.box.max.y),
                    f(p.box.max.z),
                ].join("\t"),
            );
        print(`level ${level} ${pieces.length}`);
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    print(`catalogue ${file}`);
}

// A file written under the props folder and, when the overlay is there, the same into it.
function writeBoth(out: string, relative: string, data: Buffer): void {
    for (const root of [path.join(out, PROPS_FOLDER), ...overlayRoot(out)]) {
        const target = path.join(root, ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
    }
}

function overlayRoot(out: string): string[] {
    const overlay = path.join(out, OVERLAY);
    return fs.existsSync(overlay) ? [overlay] : [];
}

export function thumbs(game: string, out: string, level: string, size: number): number {
    const data = readLevel(game, level, true);
    const materials = new Map(data.scene.materials.map((m) => [m.checksum, m]));
    const textures = new TextureSet(data.tex);
    const sectors = new Map(data.scene.sectors.map((s) => [s.checksum, s]));
    const folder = path.join(out, PROPS_FOLDER, "images", "props", data.level.toLowerCase());
    const stampFile = path.join(folder, THUMB_STAMP);
    const stamp = `prop-thumbs ${THUMB_VERSION} ${size}
`;
    // (pictures of another renderer or size: all drawn again)
    const current = fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp;
    let made = 0;
    for (const piece of piecesOf(data)) {
        const name = hex8(piece.checksum).toLowerCase();
        const relative = `images/props/${data.level.toLowerCase()}/${name}.img.xbx`;
        const here = path.join(out, PROPS_FOLDER, ...relative.split("/"));
        if (!current || !fs.existsSync(here)) {
            const parts = piece.members.map((m) => sectors.get(m)!);
            writeBoth(out, relative, nativeImg(thumbnail(parts, materials, textures, size)));
            made += 1;
        } else {
            for (const root of overlayRoot(out)) {
                const target = path.join(root, ...relative.split("/"));
                if (!fs.existsSync(target)) {
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.copyFileSync(here, target);
                }
            }
        }
        print(`thumb ${data.level} ${name}`);
    }
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(stampFile, stamp);
    print(`thumbs ${data.level} ${made}`);
    return made;
}

export function extract(game: string, out: string, level: string, pieceName: string): string {
    const id = packId(path.basename(levelDir(game, level)), pieceName);
    const folder = path.join(out, PROPS_FOLDER, "levels", id);
    const stampFile = path.join(folder, "source.txt");
    const stamp = sceneStamp(game, level);
    // (the level's scene and the way packs are cut: a pack cut by an older rule is cut again)
    const stampText = `${stamp.bytes} ${stamp.time} ${MANIFEST_VERSION}\n`;
    if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stampText) {
        syncPack(out, id);
        print(`pack ${id}`);
        return id;
    }
    const data = readLevel(game, level, true);
    const piece = piecesOf(data).find((p) => p.name.toLowerCase() === pieceName.toLowerCase());
    if (!piece) exitWith(`${level} has no piece named ${pieceName}`);
    const pack = makePack(data, piece);
    writePack(pack, path.join(out, PROPS_FOLDER));
    fs.writeFileSync(stampFile, stampText);
    syncPack(out, id);
    print(`pack ${id}`);
    return id;
}

function copyTree(from: string, to: string): number {
    if (!fs.existsSync(from)) return 0;
    let n = 0;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, entry.name);
        const b = path.join(to, entry.name);
        if (entry.isDirectory()) n += copyTree(a, b);
        else if (entry.isFile() && entry.name !== "source.txt" && entry.name !== THUMB_STAMP) {
            fs.mkdirSync(to, { recursive: true });
            fs.copyFileSync(a, b);
            n += 1;
        }
    }
    return n;
}

function syncPack(out: string, id: string): void {
    for (const root of overlayRoot(out))
        copyTree(path.join(out, PROPS_FOLDER, "levels", id), path.join(root, "levels", id));
}

// The packs and the pictures copied into an overlay folder (make_menu_level calls this after making it again).
export function sync(out: string, overlay = path.join(out, OVERLAY)): number {
    const props = path.join(out, PROPS_FOLDER);
    if (!fs.existsSync(props) || !fs.existsSync(overlay)) return 0;
    return (
        copyTree(path.join(props, "levels"), path.join(overlay, "levels")) +
        copyTree(path.join(props, "images"), path.join(overlay, "images"))
    );
}

// A prefab's picture (the level editor's prefabs - src/editor/level_editor_prefabs.h: a layout fragment, its pieces
// as `clone` records of the level's own sectors or of prop packs' - `source <scene> <level>`, `prop <pack>`): its
// pieces placed as the records say and drawn as the pieces' pictures are, images\prefabs\<id>.img.xbx. Prints
// "thumb prefab <id>" (the picture is the background alone when none of its pieces is found).
export function prefabThumb(game: string, out: string, file: string, size: number): string {
    const id = path.basename(file).replace(/\.txt$/i, "");
    const text = fs.readFileSync(file, "utf8");
    const records = readLayoutProps(text);
    const level = /^source\s+\S+\s+(\S+)/m.exec(text)?.[1];
    const sources = new Map<number, Sector>();
    const materials = new Map<number, Material>();
    const textures = new TextureSet();
    const add = (scene: Scene, tex: TexFile | null): void => {
        for (const s of scene.sectors) if (!sources.has(s.checksum)) sources.set(s.checksum, s);
        for (const m of scene.materials) if (!materials.has(m.checksum)) materials.set(m.checksum, m);
        if (tex) textures.add(tex);
    };
    for (const pack of records.packs) {
        const dir = path.join(out, PROPS_FOLDER, "levels", pack);
        const scn = path.join(dir, `${pack}.scn.xbx`);
        const tex = path.join(dir, `${pack}.tex.xbx`);
        if (!fs.existsSync(scn)) continue;
        add(readScene(fs.readFileSync(scn), scn), fs.existsSync(tex) ? readTex(fs.readFileSync(tex), tex) : null);
    }
    const wanted = records.clones.some((c) => !sources.has(c.source));
    if (wanted && level && level !== "-" && levelsOf(game).some((l) => l.toLowerCase() === level.toLowerCase())) {
        const data = readLevel(game, level, true);
        add(data.scene, data.tex);
    }
    const parts: Sector[] = [];
    records.clones.forEach((c, k) => {
        const source = sources.get(c.source);
        if (!source) return;
        const copy = cloneSector(source, k + 1);
        placeSector(copy, c.placement);
        parts.push(copy);
    });
    writeBoth(out, `images/prefabs/${id}.img.xbx`, nativeImg(thumbnail(parts, materials, textures, size)));
    print(`thumb prefab ${id}`);
    return id;
}

async function main(): Promise<number> {
    const { values, positionals } = parseCli(USAGE, {
        allowPositionals: true,
        options: {
            game: { type: "string" },
            out: { type: "string" },
            level: { type: "string" },
            levels: { type: "string" },
            piece: { type: "string" },
            size: { type: "string" },
            prefab: { type: "string" },
            all: { type: "boolean" },
        },
    });
    const command = positionals[0] ?? "";
    if (command === "sync") {
        if (!values.out && !values.game) exitWith(USAGE);
        print(`synced ${sync(values.out ?? values.game!)} file(s)`);
        return 0;
    }
    if (!values.game || !["catalogue", "thumbs", "extract", "prefab-thumb"].includes(command)) exitWith(USAGE);
    const game = resolveInstall(values.game, "thug2");
    const out = values.out ?? game;
    if (command === "prefab-thumb") {
        if (!values.prefab) exitWith(USAGE);
        prefabThumb(game, out, values.prefab, values.size ? Number.parseInt(values.size, 10) : THUMB_SIZE);
    } else if (command === "catalogue") {
        catalogue(game, out, values.levels ? values.levels.split(",") : null);
    } else if (command === "thumbs") {
        if (!values.level === !values.all) exitWith(USAGE);
        const size = values.size ? Number.parseInt(values.size, 10) : THUMB_SIZE;
        for (const level of values.all ? levelsOf(game) : [values.level!]) thumbs(game, out, level, size);
    } else {
        if (!values.level || !values.piece) exitWith(USAGE);
        extract(game, out, values.level, values.piece);
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
