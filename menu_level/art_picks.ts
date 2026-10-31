// NOT ORIGINAL - the level select's pictures as decided by the user (2026-10-31): per level either one of its four
// scenic pictures (art_picks.json: the variant index, 0-3) or "placeholder" - one shared, plain picture in the new front
// end's look (ink, paper and a yellow rule; no text, the level select draws the name) for the levels whose scenic views
// weren't liked, until better spots are captured. One level can be a strength trial instead: a view at several style
// strengths, switchable with Q / E (a label per picture, "70%").
//
// make_menu_level.ts reads art_picks.json by default; an --art-choices file (the level select's saved Q / E choices)
// still overrides a level.
//
//   node tools/pipeline/menu_level/art_picks.ts sheet <out folder>     the placeholder, at the HD size

import * as fs from "node:fs";
import * as path from "node:path";
import { encodeImg } from "../hd_textures/ui.ts";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { nativeImg, type Picture, readPng, resize, toPng } from "./loading_art.ts";
import * as scenicArt from "./scenic_art.ts";
import { ART_H, ART_W, contactSheet, HD_SCALE, halftone, hash01, INK, PAPER } from "./scenic_art.ts";
import { capturePath } from "./scenic_capture.ts";
import { readSpots } from "./scenic_spots.ts";

export const PICKS_FILE = path.join(import.meta.dirname, "art_picks.json");
export const PLACEHOLDER_ART = "frontend_art_placeholder";
const ACCENT = [0xf2, 0xe2, 0x05] as const; // the house accent, safety yellow (docs/design/frontend)

export interface ArtPick {
    placeholder: boolean; // the shared placeholder picture
    variant: number; // the scenic picture (0-3) - the view, for a trial
    strengths?: number[]; // a strength trial: the percentages (10, 20, ...), one picture each
}

export interface PicksFile {
    version: 1;
    levels: Record<string, { game: string; name: string; pick: number | "placeholder"; strengths?: number[] }>;
}

export function parsePicks(file: PicksFile): Map<string, ArtPick> {
    const out = new Map<string, ArtPick>();
    for (const [load, e] of Object.entries(file.levels)) {
        if (e.pick === "placeholder") {
            out.set(load.toLowerCase(), { placeholder: true, variant: 0 });
            continue;
        }
        if (!Number.isInteger(e.pick) || e.pick < 0) throw new Error(`art picks: ${load}: bad pick ${e.pick}`);
        const strengths = e.strengths;
        if (strengths && (!strengths.length || strengths.some((v) => !(v > 0 && v <= 100))))
            throw new Error(`art picks: ${load}: bad strengths`);
        out.set(load.toLowerCase(), {
            placeholder: false,
            variant: e.pick,
            ...(strengths ? { strengths: [...strengths] } : {}),
        });
    }
    return out;
}

export const readPicks = (file = PICKS_FILE): Map<string, ArtPick> =>
    parsePicks(JSON.parse(fs.readFileSync(file, "utf-8")) as PicksFile);

// --- the placeholder -------------------------------------------------------------------------------------------------

// The placeholder at w x h (16:9): an ink ground with a faint paper glow at the top right, a fine halftone screen
// that thickens towards the lower right, a hairline paper frame inset from the edge with a short yellow rule on its
// foot, and a little grain. Sizes are in pixels of the 640-wide picture, so every resolution looks alike.
export function placeholderPicture(w = ART_W, h = ART_H): Picture {
    const k = w / ART_W;
    const bgra = Buffer.alloc(w * h * 4);
    const inset = 26;
    const rule = { x0: ART_W - inset - 56, x1: ART_W - inset, y: ART_H - inset, thick: 3 };
    for (let py = 0; py < h; py++) {
        const y = (py + 0.5) / k;
        for (let px = 0; px < w; px++) {
            const x = (px + 0.5) / k;
            const along = (x / ART_W + y / ART_H) / 2; // 0 top left .. 1 bottom right
            // ground: ink lifted by a soft glow at the top right
            const glow = Math.max(
                0,
                1 - Math.hypot((x - ART_W * 0.82) / (ART_W * 0.7), (y - ART_H * 0.12) / (ART_H * 0.9)),
            );
            let a = 0.08 * glow * glow; // paper's share
            // halftone screen, 45 degrees, dots growing towards the lower right
            const dots = halftone(x, y, 5, 45, 0.02 + 0.2 * along * along, 0.7 / k);
            a += 0.11 * dots * (0.35 + 0.65 * along);
            // hairline frame
            const edge = Math.min(x - inset, ART_W - inset - x, y - inset, ART_H - inset - y);
            const inside = x > inset - 1 && x < ART_W - inset + 1 && y > inset - 1 && y < ART_H - inset + 1;
            if (inside) a += 0.26 * Math.max(0, 1 - Math.abs(edge) / (0.6 / 1));
            let r = INK[0] + (PAPER[0] - INK[0]) * a;
            let g = INK[1] + (PAPER[1] - INK[1]) * a;
            let b = INK[2] + (PAPER[2] - INK[2]) * a;
            // the yellow rule on the frame's foot
            const onRule = x >= rule.x0 && x <= rule.x1 && Math.abs(y - rule.y + rule.thick / 2) <= rule.thick / 2;
            if (onRule) [r, g, b] = ACCENT;
            // grain
            const n = (hash01(px, py, 11) - 0.5) * 3;
            const o = (py * w + px) * 4;
            bgra[o] = Math.round(Math.min(255, Math.max(0, b + n)));
            bgra[o + 1] = Math.round(Math.min(255, Math.max(0, g + n)));
            bgra[o + 2] = Math.round(Math.min(255, Math.max(0, r + n)));
            bgra[o + 3] = 255;
        }
    }
    return { width: w, height: h, bgra };
}

// Its image files: the native 640 x 360 and the HD (x4) one, as scenic_art.levelArt writes a level's.
export function placeholderArt(): { nativeFile: Buffer; hdFile: Buffer; hd: Picture; native: Picture } {
    const hd = placeholderPicture(ART_W * HD_SCALE, ART_H * HD_SCALE);
    const native = resize(hd, ART_W, ART_H);
    const original = { tw: ART_W, th: ART_H, iw: ART_W, ih: ART_H, bgra: Buffer.alloc(0) };
    return { hd, native, nativeFile: nativeImg(native), hdFile: encodeImg(original, hd.bgra, HD_SCALE, true) };
}

// --- contact sheets ----------------------------------------------------------------------------------------------------

// The sheets for looking at the picks: the placeholder, the strength trial's pictures in one sheet, and a sheet per
// game of the final pictures (the chosen scenic one, or the placeholder), at the native size.
export function pickSheets(out: string): string[] {
    const written: string[] = [];
    const save = (name: string, picture: Picture): void => {
        const file = path.join(out, name);
        fs.writeFileSync(file, toPng(picture));
        written.push(file);
    };
    const placeholder = placeholderArt();
    save("placeholder_hd.png", placeholder.hd);
    const picks = JSON.parse(fs.readFileSync(PICKS_FILE, "utf-8")) as PicksFile;
    const style = "a";
    const tileW = 400;
    const tileH = 225;
    const perGame = new Map<string, { picture: Picture; label: string }[]>();
    for (const game of ["thug2", "thug1", "thps4", "thps3", "thps2", "thaw", "thp8", "misc"]) {
        const tiles: { picture: Picture; label: string }[] = [];
        const spotsPath = scenicArt.spotsFile(game);
        const spots = fs.existsSync(spotsPath) ? readSpots(spotsPath) : undefined;
        for (const [load, e] of Object.entries(picks.levels)) {
            if (e.game !== game) continue;
            let picture: Picture = resize(placeholder.native, tileW, tileH);
            let label = `${e.name} PLACEHOLDER`;
            const found =
                spots &&
                Object.entries(spots.levels).find(([lvl, s]) => (s.load ?? `load_${lvl}`).toLowerCase() === load);
            if (e.pick !== "placeholder" && found) {
                const [lvl, entry] = found;
                const ids = scenicArt.pickVariants(entry, (id) => fs.existsSync(capturePath(game, lvl, id)));
                const capture = readPng(fs.readFileSync(capturePath(game, lvl, ids[e.pick]!)));
                const colour = scenicArt.GAME_COLOURS[game] ?? "#C9CBD0";
                if (e.strengths) {
                    const fitted = scenicArt.fitCapture(capture, ART_W, ART_H);
                    const styled = scenicArt.applyStyle(fitted, scenicArt.STYLES[style], colour);
                    save(
                        "strengths_boston.png",
                        contactSheet(
                            e.strengths.map((s) => ({
                                picture: resize(scenicArt.blendPictures(fitted, styled, s / 100), tileW, tileH),
                                label: `${e.name} ${s}%`,
                            })),
                            2,
                            tileW,
                            tileH,
                        ),
                    );
                    picture = resize(styled, tileW, tileH);
                    label = `${e.name} (TRIAL, 100%)`;
                } else {
                    picture = resize(scenicArt.levelArt(capture, scenicArt.STYLES[style], colour).native, tileW, tileH);
                    label = `${e.name} ${e.pick + 1}`;
                }
            }
            tiles.push({ picture, label });
        }
        if (tiles.length) perGame.set(game, tiles);
    }
    for (const [game, tiles] of perGame) save(`picks_${game}.png`, contactSheet(tiles, 4, tileW, tileH));
    return written;
}

const USAGE = "usage: art_picks.ts sheet <out folder> (the placeholder only) | sheets <out folder>";

function main(): number {
    const { positionals } = parseCli(USAGE, { options: {}, allowPositionals: true });
    if (positionals[0] === "sheet" && positionals[1]) {
        fs.mkdirSync(positionals[1], { recursive: true });
        const file = path.join(positionals[1], "placeholder_hd.png");
        fs.writeFileSync(file, toPng(placeholderArt().hd));
        print(file);
        return 0;
    }
    if (positionals[0] === "sheets" && positionals[1]) {
        fs.mkdirSync(positionals[1], { recursive: true });
        for (const file of pickSheets(positionals[1])) print(file);
        return 0;
    }
    print(USAGE);
    return 2;
}

if (isMain(import.meta.url)) await runMain(() => main());
