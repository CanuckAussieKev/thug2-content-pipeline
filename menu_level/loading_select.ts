// NOT ORIGINAL - every level's loading screen is its level select picture, with the loading bar over it.
//
// The new front end's level select shows one picture per level (levels.json's `art`: text-free, 640 x 360 for the
// scenic ones and 640 x 448 for the cropped ones). This writes a loading picture from each of them -
// images\loadscrn_sel_<load>__<original>.img.xbx, 640 x 360 (the part of the level select picture the front end shows
// at 16:9) - and points that level's loading_screen (Levels.qb) at it. Nothing else in the game changes: the load
// script (loading_screens.qb) adds "_story" / "_classic" to a level's picture in those modes, and the DLL
// (src/game/gfx/loading_screen.cpp) takes that off again, draws the picture cover-fitted to the screen and puts a plate
// and a clean bar over it. The name keeps the original picture after the "__": `[features]
// level_select_loading_screens=0` makes the DLL load that one instead (the original's loading screens, text and all).
//
//   node tools/pipeline/menu_level/loading_select.ts preview <overlay folder> <out folder> [--fraction 0.6] [--per-game 3]
//        PNGs of the overlay's new loading screens (a few per game) as the game draws them at 1280 x 720, the bar full to
//        --fraction: the picture, the plate, the bar - the DLL's loading_bar.cpp / loading_screen.cpp geometry.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { field, structureBlocks } from "./frontend_levels.ts";
import { nativeImg, type Picture, readImg, resize, toPng } from "./loading_art.ts";

export const SELECT_PREFIX = "loadscrn_sel_";
export const PICTURE_W = 640;
export const PICTURE_H = 360; // (16:9: what the DLL fits to the screen)

// The loading_screen a level gets: its load script (lower case) and the picture it had.
export const selectName = (load: string, original: string): string =>
    `${SELECT_PREFIX}${load.toLowerCase()}__${original}`;

// The level select picture as the loading picture: 640 x 360, a taller picture cut evenly top and bottom (as the front
// end's cover fit at 16:9, without its pan), a flatter one stretched up.
export function composeSelectPicture(art: Picture): Picture {
    const scaled =
        art.width === PICTURE_W ? art : resize(art, PICTURE_W, Math.round((art.height * PICTURE_W) / art.width));
    if (scaled.height === PICTURE_H) return scaled;
    if (scaled.height < PICTURE_H) return resize(scaled, PICTURE_W, PICTURE_H);
    const top = Math.floor((scaled.height - PICTURE_H) / 2);
    return {
        width: PICTURE_W,
        height: PICTURE_H,
        bgra: Buffer.from(scaled.bgra.subarray(top * PICTURE_W * 4, (top + PICTURE_H) * PICTURE_W * 4)),
    };
}

export interface SelectScreens {
    images: Map<string, Buffer>; // name -> its images\<name>.img.xbx
    screens: Map<string, string>; // load script (lower case) -> the new loading_screen
    pictures: Map<string, Picture>; // name -> the picture (for looking at)
    missing: string[]; // levels with no level select picture to read: they keep their loading screen
    lines: string[];
}

// The level -> original loading_screen of Levels.qb text, for the levels in `art` (load script lower case -> the image
// name under the overlay's images folder, as levels.json has it).
export function originalScreens(levelsText: string, loads: Iterable<string>): Map<string, string> {
    const wanted = new Set([...loads].map((l) => l.toLowerCase()));
    const out = new Map<string, string>();
    for (const { body } of structureBlocks(levelsText)) {
        const load = field(body, "load_script")?.toLowerCase();
        const screen = field(body, "loading_screen");
        if (load && screen && wanted.has(load)) out.set(load, screen);
    }
    return out;
}

// The pictures of `art` (load script lower case -> image name) read from the overlay's images folder.
export function buildSelectScreens(
    overlay: string,
    levelsText: string,
    art: ReadonlyMap<string, string>,
): SelectScreens {
    const built: SelectScreens = { images: new Map(), screens: new Map(), pictures: new Map(), missing: [], lines: [] };
    const originals = originalScreens(levelsText, art.keys());
    for (const [load, image] of [...art].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const original = originals.get(load.toLowerCase());
        const file = path.join(overlay, "images", `${image}.img.xbx`);
        if (original === undefined || !fs.existsSync(file)) {
            built.missing.push(load);
            continue;
        }
        const picture = composeSelectPicture(readImg(fs.readFileSync(file)));
        const name = selectName(load, original);
        built.images.set(name, nativeImg(picture));
        built.pictures.set(name, picture);
        built.screens.set(load.toLowerCase(), name);
    }
    built.lines.push(`${built.images.size} level select pictures as loading screens`);
    if (built.missing.length)
        built.lines.push(`no picture for ${built.missing.join(", ")}: their loading screens kept`);
    return built;
}

// Levels.qb text with each of these levels' loading_screen set (a structure whose load_script is in `screens`).
export function applySelectScreens(levelsText: string, screens: ReadonlyMap<string, string>): string {
    let out = "";
    let at = 0;
    for (const block of structureBlocks(levelsText)) {
        const load = field(block.body, "load_script");
        const name = load ? screens.get(load.toLowerCase()) : undefined;
        if (name === undefined) continue;
        out += levelsText.slice(at, block.start) + block.body.replace(/(loading_screen=)"[^"]*"/i, `$1"${name}"`);
        at = block.end;
    }
    return out + levelsText.slice(at);
}

export function writeSelectScreens(overlay: string, built: SelectScreens): void {
    const dir = path.join(overlay, "images");
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of built.images) fs.writeFileSync(path.join(dir, `${name}.img.xbx`), data);
}

// --- the bar over it, as the DLL draws it ---------------------------------------------------------------------------

// The look the DLL gives the bar over these pictures (loading_screen.cpp ApplyBarStyle, loading_bar.cpp): 300 of 640
// units wide, paper grey to safety yellow, a dark track, on an ink plate with a yellow rule.
export const BAR = {
    width: 300,
    start: [0xb9, 0xb5, 0xac],
    end: [0xf2, 0xe2, 0x05],
    track: [0x3a, 0x3a, 0x38],
    plate: [0x0a, 0x0a, 0x0a],
    rule: [0xf2, 0xe2, 0x05],
} as const;

// `picture` (16:9) at w x h with the plate and the bar `fraction` full drawn the way loading_bar.cpp does.
export function drawLoadingScreen(picture: Picture, w: number, h: number, fraction: number): Picture {
    // (the DLL cover-fits the 16:9 picture: nothing left over at a 16:9 size)
    const base = resize(picture, w, h);
    const out: Picture = { width: w, height: h, bgra: Buffer.from(base.bgra) };
    const fill = (x0: number, y0: number, x1: number, y1: number, colour: (x: number) => readonly number[]): void => {
        for (let y = Math.max(0, Math.trunc(y0)); y < Math.min(h, Math.trunc(y1)); y++) {
            for (let x = Math.max(0, Math.trunc(x0)); x < Math.min(w, Math.trunc(x1)); x++) {
                const [r, g, b] = colour(x) as [number, number, number];
                out.bgra.set([b, g, r, 255], (y * w + x) * 4);
            }
        }
    };
    const xScale = w / 640;
    const yScale = h / 480;
    const gradientWidth = Math.trunc((w * BAR.width) / 640);
    const left = Math.trunc((w - gradientWidth) / 2);
    const filled = Math.trunc(gradientWidth * Math.min(fraction, 1)) + left;
    const frameLeft = Math.trunc(left - xScale * 5);
    const frameRight = Math.trunc(gradientWidth + frameLeft + xScale * 10);
    const top = Math.trunc(yScale * 420);
    const bottom = Math.trunc(top + yScale * 20);
    const padX = xScale * 18;
    const padY = yScale * 14;
    fill(frameLeft - padX, top - padY, frameRight + padX, bottom + padY, () => BAR.plate);
    fill(frameLeft - padX, top - padY, frameRight + padX, top - padY + yScale * 2, () => BAR.rule);
    fill(frameLeft, top, frameRight, bottom, () => BAR.track); // the frame
    const inset = yScale * 5;
    const lerp = (x: number): number[] => {
        const t = (x - left) / gradientWidth;
        return BAR.start.map((s, i) => Math.round(s + (BAR.end[i]! - s) * t));
    };
    fill(left, top + inset, left + gradientWidth, bottom - inset, lerp);
    fill(filled, top, frameRight, bottom, () => BAR.track); // not reached yet
    return out;
}

// --- previews -------------------------------------------------------------------------------------------------------

// Picks `perGame` of each game's loading screens (spread over its list) from the overlay's images, by levels.json's sections.
export function previewSample(overlay: string, perGame: number): { section: string; file: string }[] {
    const dir = path.join(overlay, "images");
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().startsWith(SELECT_PREFIX) && f.endsWith(".img.xbx"));
    const json = JSON.parse(fs.readFileSync(path.join(overlay, "frontend", "levels.json"), "utf8")) as {
        sections: { id: string; levels: { load: string }[] }[];
    };
    const out: { section: string; file: string }[] = [];
    for (const section of json.sections) {
        const mine = section.levels
            .map((l) => files.find((f) => f.toLowerCase().startsWith(`${SELECT_PREFIX}${l.load.toLowerCase()}__`)))
            .filter((f): f is string => f !== undefined);
        const step = Math.max(1, Math.floor(mine.length / perGame));
        for (let i = 0; i < mine.length && out.filter((o) => o.section === section.id).length < perGame; i += step)
            out.push({ section: section.id, file: mine[i]! });
    }
    return out;
}

const USAGE = "usage: loading_select.ts preview <overlay folder> <out folder> [--fraction 0.6] [--per-game 3]";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: { fraction: { type: "string" }, "per-game": { type: "string" } },
        allowPositionals: true,
    });
    if (positionals[0] !== "preview" || !positionals[1] || !positionals[2]) {
        print(USAGE);
        return 2;
    }
    const fraction = Number(values.fraction ?? 0.6);
    const sample = previewSample(positionals[1], Number(values["per-game"] ?? 3));
    fs.mkdirSync(positionals[2], { recursive: true });
    for (const { section, file } of sample) {
        const picture = readImg(fs.readFileSync(path.join(positionals[1], "images", file)));
        const name = `${section}_${file.slice(SELECT_PREFIX.length).replace(/__.*/, "")}.png`;
        fs.writeFileSync(path.join(positionals[2], name), toPng(drawLoadingScreen(picture, 1280, 720, fraction)));
        print("wrote", name);
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
