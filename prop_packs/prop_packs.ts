// NOT ORIGINAL - prop packs (pack.ts): the level editor's Content Browser runs these with the Node runtime it ships
// (the decomp's src/editor/level_editor_content.h):
//
//   node prop_packs/prop_packs.ts catalogue --game <THUG2> [--out <folder>] [--levels A,B]
//   node prop_packs/prop_packs.ts thumbs --game <THUG2> --level <L> [--out <folder>] [--size N]
//   node prop_packs/prop_packs.ts extract --game <THUG2> --level <L> --piece <name> [--out <folder>]
//   node prop_packs/prop_packs.ts sync [--out <folder>]
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
//   thumbs     a small picture of each of the level's pieces, images\props\<l>\<checksum>.img.xbx (those there kept);
//              prints "thumb <L> <checksum>" for each one made, then "thumbs <L> <count>".
//   extract    the piece cut out into a pack (pack.ts makePack); prints "pack <id>" (made again only when its level
//              changed since).
//   sync       the packs and pictures copied into the overlay.

import * as fs from "node:fs";
import * as path from "node:path";
import { exitWith, isMain, parseCli, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { findCaseless, resolveInstall } from "thug2-level-converter-core/lib/install.ts";
import { hex8 } from "thug2-level-converter-core/lib/text.ts";
import { nativeImg } from "../menu_level/loading_art.ts";
import {
    levelDir,
    levelsOf,
    makePack,
    packId,
    piecesOf,
    readLevel,
    textureColours,
    thumbnail,
    writePack,
} from "./pack.ts";

const USAGE =
    "usage: prop_packs.ts catalogue|thumbs|extract|sync --game THUG2 [--out FOLDER] [--level L] [--levels A,B] [--piece NAME] [--size N]";

export const PROPS_FOLDER = "thug2-decomp-props";
export const OVERLAY = "thug2-decomp-data";
export const CATALOGUE = "catalogue.txt";
const THUMB_SIZE = 64;

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
    const colours = textureColours(data.tex);
    const sectors = new Map(data.scene.sectors.map((s) => [s.checksum, s]));
    let made = 0;
    for (const piece of piecesOf(data)) {
        const name = hex8(piece.checksum).toLowerCase();
        const relative = `images/props/${data.level.toLowerCase()}/${name}.img.xbx`;
        const here = path.join(out, PROPS_FOLDER, ...relative.split("/"));
        if (!fs.existsSync(here)) {
            const parts = piece.members.map((m) => sectors.get(m)!);
            writeBoth(out, relative, nativeImg(thumbnail(parts, materials, colours, size)));
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
    print(`thumbs ${data.level} ${made}`);
    return made;
}

export function extract(game: string, out: string, level: string, pieceName: string): string {
    const id = packId(path.basename(levelDir(game, level)), pieceName);
    const folder = path.join(out, PROPS_FOLDER, "levels", id);
    const stampFile = path.join(folder, "source.txt");
    const stamp = sceneStamp(game, level);
    const stampText = `${stamp.bytes} ${stamp.time}\n`;
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
        else if (entry.isFile() && entry.name !== "source.txt") {
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
        },
    });
    const command = positionals[0] ?? "";
    if (command === "sync") {
        if (!values.out && !values.game) exitWith(USAGE);
        print(`synced ${sync(values.out ?? values.game!)} file(s)`);
        return 0;
    }
    if (!values.game || !["catalogue", "thumbs", "extract"].includes(command)) exitWith(USAGE);
    const game = resolveInstall(values.game, "thug2");
    const out = values.out ?? game;
    if (command === "catalogue") {
        catalogue(game, out, values.levels ? values.levels.split(",") : null);
    } else if (command === "thumbs") {
        if (!values.level) exitWith(USAGE);
        thumbs(game, out, values.level, values.size ? Number.parseInt(values.size, 10) : THUMB_SIZE);
    } else {
        if (!values.level || !values.piece) exitWith(USAGE);
        extract(game, out, values.level, values.piece);
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
