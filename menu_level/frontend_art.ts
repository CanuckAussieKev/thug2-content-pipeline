// NOT ORIGINAL - the new front end's text-free pictures of the ported levels. The ported games' own loading pictures
// (loading_art_games.ts) have the level's name, "Loading...", logos baked in; the level select draws its own big level
// name, so it shows these variants instead (images\frontend_art_<game>_<level>.img.xbx, named in levels.json's `art`;
// Levels.qb's loading_screen - the game's real loading screen - keeps the original picture with its text).
//
// A variant is the same game's picture (or another picture of the same game when the text sits in the middle) cut
// down to the part without text: a crop (x, y = top left, s = size, all fractions of the 640 x 448 picture - the crop
// keeps the 640:448 aspect) stretched back to 640 x 448 (the front end cover-crops and pans that, as every picture).
// No inpainting, nothing drawn: only parts of the games' own pictures.
//
//   node tools/pipeline/menu_level/frontend_art.ts check                    every variant can be made from the installs
//   node tools/pipeline/menu_level/frontend_art.ts export <folder>          them all as PNGs (for looking at)
//   (--thps2 / --thps3 / --thps4 / --thug1 / --thaw / --thp8 <folder>: where a game is, else C:\Games\<GAME>)

import * as fs from "node:fs";
import * as path from "node:path";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { cropFraction, nativeImg, type Picture, readImg, resize, SCREEN_H, SCREEN_W, toPng } from "./loading_art.ts";
import { ART, type ArtSource, findInstalls, GAMES, type Game, GameArt } from "./loading_art_games.ts";

// What a level's text-free picture is: `crop` of `source` (a picture key of GameArt.read; the loading picture the level
// has in ART when there is none here) and why.
export interface FrontVariant {
    crop: readonly [x: number, y: number, s: number];
    source?: string;
    why: string;
}

const LOGO_THPS2 =
    "THUG1's picture with THPS2's logo (the name bar and LOADING cut away; no text-free part is big enough)";
const BLANK_BOARD =
    "s2bgd6.bmp, the career's pinboard with a blank sheet of paper (the invitation cards all have text)";
const WHOLE: FrontVariant["crop"] = [0, 0, 1];

// THPS3: the three photos in the film strip are the picture, the level's name is under the strip: the middle photo.
const STRIP = "the film strip's middle photo (the level's name is under the strip)";
const strip = (x = 0.42, y = 0.21, s = 0.38): FrontVariant => ({ crop: [x, y, s], why: STRIP });

// THPS4: three pinned photos with the name and LOADING... over their lower edge (Chicago and Motox: a "Featured in
// Pro BMX 2" banner at the top as well).
const PHOTOS = "the pinned photos (the name and LOADING... are over their lower edge)";
const photos = (x = 0.3, y = 0.06, s = 0.56): FrontVariant => ({ crop: [x, y, s], why: PHOTOS });

// THUG1: the level's name in the bar at the top, the LOADING logo at the bottom, and the level's picture between.
const BETWEEN = "the part between the name bar at the top and the LOADING logo at the bottom";
const between = (x: number, y = 0.15, s = 0.62): FrontVariant => ({ crop: [x, y, s], why: BETWEEN });

// THAW: the film strip's middle photo (the name is on the strip).
const THAW_STRIP = "the film strip's middle photo (the level's name is on the strip)";
const thawStrip = (): FrontVariant => ({ crop: [0.41, 0.235, 0.36], why: THAW_STRIP });

// THP8: the card's photo alone (the torn edge, "LOADING" and THP8's logo behind it are left out).
const PHOTO = "the level select card's photo alone (no torn edge, THP8's logo or LOADING)";
const photo = (name: string): FrontVariant => ({ crop: WHOLE, source: `photo:${name}`, why: PHOTO });

// THPS2's "Loading..." picture (the game mode's, not the level's): the collage below the word.
const LOADING_COLLAGE = "load_fre.bmp below the word Loading...";
const collage = (): FrontVariant => ({ crop: [0.35, 0.22, 0.6], why: LOADING_COLLAGE });

export const FRONT: Readonly<Record<Game, Readonly<Record<string, FrontVariant>>>> = {
    thps3: {
        load_foun: strip(),
        load_can: strip(),
        load_rio: strip(),
        load_sub: strip(),
        load_thps3_ap: strip(),
        load_si: strip(),
        load_thps3_la: strip(),
        load_tok: strip(),
        load_shp: strip(),
        load_ware: strip(),
        load_burn: strip(),
        load_ros: strip(),
        load_thps3_tut: { crop: [0.55, 0, 0.45], why: "the top right (TUTORIALS is at the left)" },
    },
    thps4: {
        load_sch: photos(),
        load_sf2: photos(),
        load_alc: photos(0.28, 0.08, 0.6),
        load_kon: photos(0.42, 0.12, 0.5),
        load_jnk: photos(),
        load_lon: photos(),
        load_zoo: photos(),
        load_cnv: photos(),
        load_hof: photos(0.3, 0.21, 0.44),
        load_motox: photos(0.3, 0.21, 0.44),
        load_practice: { crop: [0, 0, 0.38], why: "the top left corner (THPS4's logo is in the middle)" },
    },
    thug1: {
        load_nj: between(0),
        load_ny: between(0.2),
        load_fl: between(0),
        load_sd: between(0),
        load_hi: between(0),
        load_vc: between(0),
        load_sj: { crop: [0, 0.2, 0.3], why: "the lights at the left (the Slam City Jam logo is to the right)" },
        load_ru: between(0),
        load_hh: { crop: [0.1, 0.36, 0.42], why: "the band under the lit letters" },
        load_vn: { crop: [0.2, 0.14, 0.6], why: LOGO_THPS2 },
        load_hn: { crop: [0.2, 0.14, 0.6], why: LOGO_THPS2 },
        load_sc2: { crop: [0.2, 0.14, 0.6], why: LOGO_THPS2 },
        load_thug1_sc: {
            crop: [0, 0.14, 0.2],
            why: "the dark blue at the left (THUG1's generic picture has the game logo in the middle)",
        },
        load_thug1_dj: {
            crop: [0, 0.14, 0.2],
            why: "the dark blue at the left (THUG1's generic picture has the game logo in the middle)",
        },
        load_thug1_ph: {
            crop: [0, 0.14, 0.2],
            why: "the dark blue at the left (THUG1's generic picture has the game logo in the middle)",
        },
        load_thug1_nj_skateshop: {
            crop: [0, 0.14, 0.3],
            why: "the brick wall and the red star at the left (Peralta's logo is to the right)",
        },
    },
    thaw: {
        load_skatepark: thawStrip(),
        load_z_ma: thawStrip(),
        load_z_dn: thawStrip(),
        load_kyoto: thawStrip(),
        load_sz: thawStrip(),
        load_z_sv2: { crop: [0.41, 0.235, 0.36], source: "wpc:loadscrn_ruins_classic", why: THAW_STRIP },
        load_vans: { crop: [0.38, 0, 0.58], why: "the right part (the VANS logo is at the bottom left)" },
        load_z_ho: {
            crop: [0.12, 0, 0.4],
            why: "the cartoon's top left (the skaters and the sun; HOLLYWOOD and the words are lower)",
        },
        load_z_bh: { crop: [0.15, 0.03, 0.4], why: "the poster's top (the title is lower)" },
        load_z_dt: { crop: [0.2, 0.52, 0.45], why: "the poster's lower part (the title is above)" },
        load_z_el: { crop: [0.3, 0.55, 0.45], why: "the poster's lower part (the title is above)" },
        load_z_sm: { crop: [0.55, 0.05, 0.36], why: "the poster's top right (the title is at the left)" },
        load_z_sr: {
            crop: [0, 0.35, 0.25],
            why: "the chain link fence at the left (the sign with the title is to the right)",
        },
        load_z_lv: { crop: [0.25, 0.03, 0.36], why: "the poster's top (the title is lower)" },
        load_z_oi: { crop: [0.15, 0.05, 0.38], why: "the poster's top left (the title is lower right)" },
    },
    thps2: {
        load_thps2_hangar: collage(),
        load_thps2_school2: collage(),
        load_thps2_ny: collage(),
        load_thps2_venice: collage(),
        load_thps2_philly: collage(),
        load_thps2_marseille: { crop: [0.25, 0.1, 0.55], source: "bmp:s2bgd6", why: BLANK_BOARD },
        load_thps2_skatestreet: { crop: [0.25, 0.1, 0.55], source: "bmp:s2bgd6", why: BLANK_BOARD },
        load_thps2_bullring: { crop: [0.25, 0.1, 0.55], source: "bmp:s2bgd6", why: BLANK_BOARD },
        load_thps2_skateheaven: {
            crop: [0.2, 0.22, 0.52],
            why: "the picture between ASCENDING TO... and ...SKATE HEAVEN",
        },
        load_thps2_chopperdrop: { crop: [0.2, 0.26, 0.6], why: "the picture under the title" },
    },
    thp8: {
        load_thp8_net_beavervalley: photo("adventure"),
        load_thp8_net_skatepark: photo("cretepark"),
        load_thp8_net_factory: photo("Factory"),
        load_thp8_net_slums: photo("Ghetto"),
        load_thp8_net_suburbia: photo("houses"),
        load_thp8_net_mainstreet: photo("shops"),
        load_thp8_net_funpark: photo("Cartoon"),
        load_thp8_net_school: photo("schoolin"),
        load_thp8_net_industrial: photo("Ghetto"),
        load_thp8_net_capitol: photo("Capitol"),
        load_thp8_net_skatefunparks: photo("Cartoon"),
        load_thp8_net_skatecentral: photo("park"),
        load_thp8_bedroom: { crop: [0, 0.3, 0.35], why: "the left end of the band and sky (the logo is to the right)" },
        load_thp8_skateshop: {
            crop: [0, 0.3, 0.35],
            why: "the left end of the band and sky (the logo is to the right)",
        },
        load_thp8_training: {
            crop: [0, 0.3, 0.35],
            why: "the left end of the band and sky (the logo is to the right)",
        },
    },
};

// The variant's picture name in the overlay (frontend_art_<game>_<level>; `loadscrn` is for the real loading screens).
export const frontArtName = (game: Game, load: string): string =>
    `frontend_art_${game}_${load.toLowerCase().replace(/^load_/, "")}`;

export interface BuiltFrontArt {
    images: Map<string, Buffer>; // art name -> its images\<name>.img.xbx
    art: Map<string, string>; // load script (lower case) -> art name
    pictures: Map<string, Picture>; // art name -> the picture (for looking at)
    lines: string[];
}

// The text-free pictures of `loads` (the load scripts, lower case, of the levels in the overlay) from the installs
// that are there (`installs`: resolved folders; a game without one is left out, its levels keep their loading picture).
export function buildFrontArt(installs: Partial<Record<Game, string>>, loads: ReadonlySet<string>): BuiltFrontArt {
    const images = new Map<string, Buffer>();
    const art = new Map<string, string>();
    const pictures = new Map<string, Picture>();
    const lines: string[] = [];
    for (const game of GAMES) {
        const wanted = Object.entries(FRONT[game])
            .filter(([load]) => loads.has(load))
            .sort(([a], [b]) => (a < b ? -1 : 1));
        const dir = installs[game];
        if (wanted.length === 0 || dir === undefined) continue;
        const reader = new GameArt(game, dir);
        const cache = new Map<string, Picture>();
        try {
            for (const [load, variant] of wanted) {
                const source = variant.source ?? (ART[game][load] as ArtSource).source;
                let whole = cache.get(source);
                if (whole === undefined) {
                    whole = resize(reader.read(source), SCREEN_W, SCREEN_H);
                    cache.set(source, whole);
                }
                const [x, y, s] = variant.crop;
                const picture = s >= 1 ? whole : cropFraction(whole, x, y, s, SCREEN_W, SCREEN_H);
                const name = frontArtName(game, load);
                images.set(name, nativeImg(picture));
                pictures.set(name, picture);
                art.set(load, name);
            }
        } finally {
            reader.close();
        }
        lines.push(`${game}: ${wanted.length} text-free pictures`);
    }
    return { images, art, pictures, lines };
}

// Writes the pictures into the overlay (images\<name>.img.xbx; the hd_ui pass upscales them like the loading screens).
export function writeFrontArt(overlay: string, built: BuiltFrontArt): void {
    const dir = path.join(overlay, "images");
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of built.images) fs.writeFileSync(path.join(dir, `${name}.img.xbx`), data);
}

const USAGE = "usage: frontend_art.ts check | export <out folder> [--thps2 DIR] [--thps3 DIR] ...";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: Object.fromEntries(GAMES.map((g) => [g, { type: "string" as const }])),
        allowPositionals: true,
    });
    const overrides: Partial<Record<Game, string>> = {};
    for (const game of GAMES) if (values[game]) overrides[game] = values[game] as string;
    const loads = new Set(GAMES.flatMap((g) => Object.keys(FRONT[g])));
    const built = buildFrontArt(findInstalls(overrides), loads);
    for (const line of built.lines) print(line);
    const command = positionals[0];
    if (command === "export" && positionals[1]) {
        fs.mkdirSync(positionals[1], { recursive: true });
        for (const [name, data] of built.images) {
            fs.writeFileSync(path.join(positionals[1], `${name}.png`), toPng(readImg(data)));
        }
        return 0;
    }
    if (command === "check") return built.art.size === loads.size ? 0 : 1;
    print(USAGE);
    return 2;
}

if (isMain(import.meta.url)) await runMain(() => main());
