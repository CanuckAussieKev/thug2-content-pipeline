// NOT ORIGINAL - which picture of which game is which ported level's loading screen (loading_art.ts has the readers
// and the evidence in its header), and building them: the table ART (our levels' load scripts, as levels.json has
// them, in lower case -> the picture and why), the reading of each game's install, and the Levels.qb edit.
//
//   node tools/pipeline/menu_level/loading_art_games.ts check                 every picture of the table can be read
//   node tools/pipeline/menu_level/loading_art_games.ts export <folder>       them all as PNGs (for looking at)
//   (--thps2 / --thps3 / --thps4 / --thug1 / --thaw / --thp8 <folder>: where a game is, else C:\Games\<GAME>)

import * as fs from "node:fs";
import * as path from "node:path";
import { checksum } from "../level_port/qb.ts";
import { parseCli } from "../lib/cli.ts";
import { findCaseless, findInstall } from "../lib/install.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { entryData, openPak, unpack } from "../thp8_levels/thp8.ts";
import { Pkr } from "../thps2_levels/pkr.ts";
import { field, structureBlocks } from "./frontend_levels.ts";
import {
    cardPhoto,
    composeCard,
    nativeImg,
    type Picture,
    readBmp8,
    readImg,
    readPng,
    readWpcImg,
    readXenImg,
    resize,
    SCREEN_H,
    SCREEN_W,
    toPng,
} from "./loading_art.ts";

export type Game = "thps2" | "thps3" | "thps4" | "thug1" | "thaw" | "thp8";
export const GAMES: readonly Game[] = ["thps4", "thug1", "thps3", "thaw", "thps2", "thp8"];

// Where a level's picture is: a source key (kind:name - see GameArt.read) and why - the evidence, from the game's own
// scripts where they name one.
export interface ArtSource {
    source: string;
    why: string;
}

const thps3 = (stem: string): ArtSource => ({
    source: `png:${stem}`,
    why: `THPS3 levels.qb LevelLoadingScreens: DisplayLoadingScreen "images\\${stem}.png"`,
});
const thps4 = (stem: string): ArtSource => ({
    source: `dat:${stem}`,
    why: `THPS4 Levels.qb: the level structure's loading_screen="${stem}"`,
});
const thug1 = (stem: string, why = `THUG1 Levels.qb: the level structure's loading_screen="${stem}"`): ArtSource => ({
    source: `img:${stem}`,
    why,
});
const thaw = (stem: string, level: string): ArtSource => ({
    source: `wpc:${stem}`,
    why: `THAW levels.qb ${level}: loading_screen_default="${stem}" (loading_screens.qb takes it unless classic / online)`,
});
const FREE = "ALL.PKR data\\load_fre.bmp: THPS2's free skate loading picture (THPS2 has none per level)";
const p8 = (picture: string, list: string): ArtSource => ({
    source: `card:${picture}`,
    why: `THP8 qb.pak level_select_ui_${list}: images=[...${picture}...] (levelselect.pak), over its loadscrn_generic`,
});
const p8Generic = (level: string): ArtSource => ({
    source: "xen:loadscrn_generic",
    why: `THP8 qb.pak Level_Z_${level}: loading_screen_default="loadscrn_generic" (its own generic picture)`,
});

// Our levels' load scripts (lower case, as levels.json has them) -> the picture. A level not here has none (the front
// end keeps one of THUG2's generic screens): THPS3's skate shop (its DisplayProperLoadingScreen SkateShop names none),
// THUG2's own levels (they have theirs) and its test level.
export const ART: Readonly<Record<Game, Readonly<Record<string, ArtSource>>>> = {
    thps3: {
        load_foun: thps3("loadscrn_foundry"),
        load_can: thps3("loadscrn_can"),
        load_rio: thps3("loadscrn_rio"),
        load_sub: thps3("loadscrn_sub"),
        load_thps3_ap: thps3("loadscrn_ap"),
        load_si: thps3("loadscrn_si"),
        load_thps3_la: thps3("loadscrn_la"),
        load_tok: thps3("loadscrn_tok"),
        load_shp: thps3("loadscrn_ship"),
        load_ware: thps3("loadscrn_warehouse"),
        load_burn: thps3("loadscrn_burnside"),
        load_ros: thps3("loadscrn_roswell"),
        load_thps3_tut: thps3("loadscrn_tutorials"),
    },
    thps4: {
        load_sch: thps4("loadscrn_col"),
        load_sf2: thps4("loadscrn_sanfran"),
        load_alc: thps4("loadscrn_alcatraz"),
        load_kon: thps4("loadscrn_Kona"),
        load_jnk: thps4("loadscrn_shipyard"),
        load_lon: thps4("loadscrn_london"),
        load_zoo: thps4("loadscrn_Zoo"),
        load_cnv: thps4("loadscrn_Carnival"),
        load_hof: thps4("loadscrn_chicago"),
        load_motox: thps4("loadscrn_chicago"), // (its Level_motox says chicago too)
        load_practice: thps4("loadscrn_generic"), // (THPS4's skate shop: Level_SkateShop says loadscrn_generic)
    },
    thug1: {
        load_nj: thug1("loadscrn_jersey"),
        load_ny: thug1("loadscrn_manhattan"),
        load_fl: thug1("loadscrn_florida"),
        load_sd: thug1("loadscrn_diego"),
        load_hi: thug1("loadscrn_hawaii"),
        load_vc: thug1("loadscrn_vancouver"),
        load_sj: thug1("loadscrn_slam"),
        load_ru: thug1("loadscrn_moscow"),
        load_hh: thug1(
            "loadscrn_secret",
            'THUG1 Levels.qb Level_SE (name "Hotter Than Hell"): loading_screen="loadscrn_secret"',
        ),
        load_vn: thug1("loadscrn_THPS2_ven"),
        load_hn: thug1("loadscrn_THPS2_hang"),
        load_sc2: thug1("loadscrn_THPS2_sch"),
        load_thug1_sc: thug1("loadscrn_generic"), // (Level_SC, _DJ and _PH say loadscrn_generic)
        load_thug1_dj: thug1("loadscrn_generic"),
        load_thug1_ph: thug1("loadscrn_generic"),
        load_thug1_nj_skateshop: thug1(
            "loadscrn_boardshop",
            'THUG1 Levels.qb level_boardshop (pre="nj_skateshop.pre"): loading_screen="loadscrn_boardshop"',
        ),
    },
    thaw: {
        load_skatepark: thaw("loadscrn_chicago_classic", "Level_Z_CH"),
        load_z_ma: thaw("loadscrn_mall_classic", "Level_Z_MA"),
        load_z_dn: thaw("loadscrn_minneapolis_classic", "Level_Z_DN"),
        load_kyoto: thaw("loadscrn_kyoto_classic", "Level_Z_JA"),
        load_sz: thaw("loadscrn_santacruz_classic", "Level_Z_SZ"),
        load_z_sv2: thaw("loadscrn_ruins", "Level_Z_SV2"),
        load_vans: thaw("loadscrn_vans", "Level_Z_SV"),
        load_z_ho: thaw("loadscrn_hollywood", "Level_Z_HO"),
        load_z_bh: thaw("loadscrn_beverly_hills", "Level_Z_BH"),
        load_z_dt: thaw("loadscrn_downtown", "Level_Z_DT"),
        load_z_el: thaw("loadscrn_east_la", "Level_Z_EL"),
        load_z_sm: thaw("loadscrn_santa_monica", "Level_Z_SM"),
        load_z_sr: thaw("loadscrn_skateranch", "Level_Z_SR"),
        load_z_lv: thaw("loadscrn_casino", "Level_Z_LV"),
        load_z_oi: thaw("loadscrn_oil_rig", "Level_Z_OI"),
    },
    thps2: {
        // (THPS2 shows one picture for every level, by game mode: load_fre is its free skate's)
        load_thps2_hangar: { source: "bmp:load_fre", why: FREE },
        load_thps2_school2: { source: "bmp:load_fre", why: FREE },
        load_thps2_ny: { source: "bmp:load_fre", why: FREE },
        load_thps2_venice: { source: "bmp:load_fre", why: FREE },
        load_thps2_philly: { source: "bmp:load_fre", why: FREE },
        // (the career's competition invites and level intros, 512 x 240, with the level on them)
        load_thps2_marseille: {
            source: "bmp:s2bgd7",
            why: "ALL.PKR data\\s2bgd7.bmp: COMPETITION INVITE #1, the Bluetorch Pro Bowl Jam (a Marseille note on it)",
        },
        load_thps2_skatestreet: {
            source: "bmp:s2bgd8",
            why: "ALL.PKR data\\s2bgd8.bmp: COMPETITION INVITE #2, Plywood Paradise (the SKATE STREET logo on it)",
        },
        load_thps2_bullring: {
            source: "bmp:s2bgd9",
            why: "ALL.PKR data\\s2bgd9.bmp: COMPETITION INVITE #3, the Bullhorn Brawl (the bull logo)",
        },
        load_thps2_skateheaven: {
            source: "bmp:s2bgd11",
            why: "ALL.PKR data\\s2bgd11.bmp: ASCENDING TO ... SKATE HEAVEN",
        },
        load_thps2_chopperdrop: { source: "bmp:s2bgd12", why: "ALL.PKR data\\s2bgd12.bmp: CHOPPER DROP" },
    },
    thp8: {
        load_thp8_net_beavervalley: p8("adventure", "whole_world"),
        load_thp8_net_skatepark: p8("cretepark", "crete"),
        load_thp8_net_factory: p8("Factory", "factory"),
        load_thp8_net_slums: p8("Ghetto", "ghetto"),
        load_thp8_net_suburbia: p8("houses", "houses"),
        load_thp8_net_mainstreet: p8("shops", "shops"),
        load_thp8_net_funpark: p8("Cartoon", "funpark"),
        load_thp8_net_school: p8("schoolin", "school"),
        load_thp8_net_industrial: p8("Ghetto", "industrial"),
        load_thp8_net_capitol: p8("Capitol", "capitol"),
        load_thp8_net_skatefunparks: p8("Cartoon", "skatepark_funpark"),
        load_thp8_net_skatecentral: p8("park", "central"),
        load_thp8_bedroom: p8Generic("Bedroom"),
        load_thp8_skateshop: p8Generic("Skateshop"),
        load_thp8_training: p8Generic("Training"),
    },
};

// Where the games are by default (the converters' defaults).
export const DEFAULT_INSTALLS: Readonly<Record<Game, string>> = {
    thps2: "C:\\Games\\THPS2",
    thps3: "C:\\Games\\THPS3",
    thps4: "C:\\Games\\THPS4",
    thug1: "C:\\Games\\THUG1",
    thaw: "C:\\Games\\THAW",
    thp8: "C:\\Games\\THP8",
};

// The picture's name in the overlay: nothing of THUG2's or of another game's level can have it.
export const artName = (game: Game, load: string): string =>
    `loadscrn_${game}_${load.toLowerCase().replace(/^load_/, "")}`;

// Reads the pictures of one game's install (`dir`: its resolved folder).
export class GameArt {
    readonly game: Game;
    readonly dir: string;
    private pkr: Pkr | null = null;
    private levelSelect: ReturnType<typeof openPak> | null = null;

    constructor(game: Game, dir: string) {
        this.game = game;
        this.dir = dir;
    }

    close(): void {
        this.pkr?.close();
        this.pkr = null;
    }

    private file(...parts: string[]): string {
        const found = findCaseless(this.dir, ...parts);
        if (found === null) throw new Error(`${this.game}: ${path.join(...parts)} is not in ${this.dir}`);
        return found;
    }

    // A THP8 level select picture (levelselect.pak) by name, as it is.
    private card(name: string): Picture {
        this.levelSelect ??= openPak(this.file("DATA", "COMPRESSED", "PAK", "levelselect.pak.xen"));
        const key = checksum(name);
        const entry = this.levelSelect.entries.find((e) => e.extension === ".img" && e.name === key);
        if (!entry) throw new Error(`THP8 levelselect.pak: no picture ${name}`);
        return readXenImg(Buffer.from(entryData(this.levelSelect, entry)));
    }

    // The picture a source key names, as it is: top row first, any size. Keys: png (THPS3 Data\images\<n>.png), dat
    // (THPS4 data\images\<n>img.dat), img (THUG1 Data\images\<n>.img), wpc (THAW data\images\<n>.img.wpc), bmp (THPS2
    // ALL.PKR data\<n>.bmp), xen (THP8 IMAGES\LOADINGSCREENS\<n>.img.xen), card (a THP8 levelselect.pak picture by name,
    // over THP8's generic loading screen; photo: the same card's photo alone, frontend_art.ts).
    read(source: string): Picture {
        const [kind, name] = source.split(":") as [string, string];
        switch (kind) {
            case "png":
                return readPng(fs.readFileSync(this.file("Data", "images", `${name}.png`)));
            case "dat":
                return readImg(fs.readFileSync(this.file("data", "images", `${name}img.dat`)));
            case "img":
                return readImg(fs.readFileSync(this.file("Data", "images", `${name}.img`)));
            case "wpc":
                return readWpcImg(fs.readFileSync(this.file("data", "images", `${name}.img.wpc`)));
            case "bmp": {
                this.pkr ??= new Pkr(this.file("ALL.PKR"));
                return readBmp8(this.pkr.read(`data/${name}.bmp`));
            }
            case "xen":
                return readXenImg(
                    unpack(this.file("DATA", "COMPRESSED", "IMAGES", "LOADINGSCREENS", `${name}.img.xen`)),
                );
            case "card":
                return composeCard(this.card(name), this.read("xen:loadscrn_generic"));
            case "photo":
                return cardPhoto(this.card(name), SCREEN_W, SCREEN_H);
        }
        throw new Error(`unknown picture source ${source}`);
    }
}

export interface BuiltArt {
    images: Map<string, Buffer>; // art name -> its images\<name>.img.xbx
    art: Map<string, string>; // load script (lower case) -> art name
    lines: string[]; // the report
}

// The pictures of `loads` (the load scripts, lower case, of the levels in the overlay) from the installs that are
// there (`installs`: resolved folders; a game without one is left out, its levels keep the generic screen).
export function buildArt(installs: Partial<Record<Game, string>>, loads: ReadonlySet<string>): BuiltArt {
    const images = new Map<string, Buffer>();
    const art = new Map<string, string>();
    const lines: string[] = [];
    for (const game of GAMES) {
        const wanted = Object.entries(ART[game])
            .filter(([load]) => loads.has(load))
            .sort(([a], [b]) => (a < b ? -1 : 1));
        if (wanted.length === 0) continue;
        const dir = installs[game];
        if (dir === undefined) {
            lines.push(`${game}: no install found - ${wanted.length} levels keep THUG2's generic loading screens`);
            continue;
        }
        const reader = new GameArt(game, dir);
        const cache = new Map<string, Picture>();
        try {
            for (const [load, source] of wanted) {
                let picture = cache.get(source.source);
                if (picture === undefined) {
                    picture = resize(reader.read(source.source), SCREEN_W, SCREEN_H);
                    cache.set(source.source, picture);
                }
                const name = artName(game, load);
                images.set(name, nativeImg(picture));
                art.set(load, name);
            }
        } finally {
            reader.close();
        }
        lines.push(`${game}: ${wanted.length} of ${Object.keys(ART[game]).length} levels with a picture of their own`);
    }
    return { images, art, lines };
}

// Levels.qb text with each of these levels' loading_screen set (a structure whose load_script is Load_<x> and whose
// loading_screen is loadscrn_generic - the ported levels' own), so the game's loading screen shows the same picture.
export function applyLoadingScreens(levelsText: string, art: ReadonlyMap<string, string>): string {
    let out = "";
    let at = 0;
    for (const block of structureBlocks(levelsText)) {
        const load = field(block.body, "load_script");
        const name = load ? art.get(load.toLowerCase()) : undefined;
        if (name === undefined) continue;
        const patched = block.body.replace(/(loading_screen=)"loadscrn_generic"/i, `$1"${name}"`);
        out += levelsText.slice(at, block.start) + patched;
        at = block.end;
    }
    return out + levelsText.slice(at);
}

// Writes the pictures into the overlay (images\<name>.img.xbx: where the hd_ui pass finds them as loading screens).
export function writeArt(overlay: string, built: BuiltArt): void {
    const dir = path.join(overlay, "images");
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of built.images) fs.writeFileSync(path.join(dir, `${name}.img.xbx`), data);
}

// The installs found for the games (the folders `overrides` name, else the defaults; a game that isn't there is absent).
export function findInstalls(overrides: Partial<Record<Game, string>> = {}): Partial<Record<Game, string>> {
    const out: Partial<Record<Game, string>> = {};
    for (const game of GAMES) {
        const found = findInstall(overrides[game] ?? DEFAULT_INSTALLS[game], game);
        if (found !== null) out[game] = found;
    }
    return out;
}

const USAGE = "usage: loading_art_games.ts check | export <out folder> [--thps2 DIR] [--thps3 DIR] ...";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: Object.fromEntries(GAMES.map((g) => [g, { type: "string" as const }])),
        allowPositionals: true,
    });
    const overrides: Partial<Record<Game, string>> = {};
    for (const game of GAMES) if (values[game]) overrides[game] = values[game] as string;
    const loads = new Set(GAMES.flatMap((g) => Object.keys(ART[g])));
    const built = buildArt(findInstalls(overrides), loads);
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
