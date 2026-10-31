// NOT ORIGINAL - the data file of the DLL's new front end (src/game/front/new_frontend.h, thug2-decomp.ini [features]
// new_frontend=1): the level select's sections as the overlay's sectioned level select has them (level_select.ts),
// written by make_menu_level.ts as <overlay>\frontend\levels.json so the DLL needn't hard-code a level.
//
// Made from the final gamemenu_levelselect.qb text (after level_select.ts editLevelSelect: the same arrays, the same
// order, the same load scripts as the game's level select uses) and the final Levels.qb text (each load script's
// level structure's loading_screen - the full-bleed art). The ported levels' structures all say loadscrn_generic
// (tools/pipeline/level_port/ported_levels.ts levelsQbText): those get one of THUG2's seven generic loading screens in turn
// (generic_art) so a section doesn't show one picture for every level - until the converters bring the original
// games' own loading screens (phase 2).
//
// The file (version 1):
//   { "version": 1,
//     "menu_art": { "<main menu item id>": "<image name>", ... },
//     "sections": [ { "id": "thug2", "tab": "THUG2", "title": "TONY HAWK'S UNDERGROUND 2", "colour": "#A48BFF",
//                     "levels": [ { "name": "BOSTON", "load": "load_BO", "art": "loadscrn_boston",
//                                   "level_num": "LevelNum_BO" | 18, "flag": "LEVEL_UNLOCKED_BO",
//                                   "seen_flag": "LEVEL_SEEN_BO"?, "hide_when_locked": true?, "game_tag": "THPS4"?, "generic_art": true? }, ... ] },
//                   ... ] }
// `art` is an image name under the game's images folder (images\<art>.img.xbx: the overlay's hd_ui copy first with
// [features] hd_ui=1, as the game's own loading screens). level_num / flag are the entry's (a script name or a
// number): the DLL resolves them for the career's records and the lock.

import { reEscape } from "./career_complete.ts";
import type { Section } from "./level_select.ts";

export const FRONTEND_LEVELS = "frontend\\levels.json";

// The tabs' short names and colours (docs/design/frontend/README.md: the per-game colours), by section id.
export const SECTION_STYLE: ReadonlyMap<string, { tab: string; colour: string }> = new Map([
    ["thug2", { tab: "THUG2", colour: "#A48BFF" }],
    ["thug1", { tab: "THUG", colour: "#2FD38A" }],
    ["thps4", { tab: "THPS4", colour: "#FF6B3D" }],
    ["thps3", { tab: "THPS3", colour: "#3DB7FF" }],
    ["thps2", { tab: "THPS2", colour: "#FF4F9A" }],
    ["thaw", { tab: "THAW", colour: "#F2C230" }],
    ["thp8", { tab: "P8", colour: "#5FE0D0" }],
    ["misc", { tab: "Misc", colour: "#C9CBD0" }],
]);

// The main menu's art (the image shown while an item is highlighted), by the DLL's item ids - each item its own, none
// of THUG2's advert slides off topic (the DLL's DefaultArt has the same and the sub-screens' items; 2026-10-25).
export const MENU_ART: Readonly<Record<string, string>> = {
    career: "loadscrn_boston_story",
    story: "loadscrn_boston_story",
    classic: "loadscrn_boston_classic",
    freeskate: "loadscrn_australia",
    online: "loadscrn_Online",
    create: "loadscrn_created",
    options: "loadscrn_generic",
    quit: "loadscrn_los_angeles",
};

export const GENERIC_ART = "loadscrn_generic";
export const GENERIC_ART_COUNT = 7; // (loadscrn_generic_1 .. _7: THUG2's own)

export interface FrontendLevel {
    name: string;
    load: string;
    art: string;
    art_variants?: string[]; // the level select's pictures to choose from (Q / E), [0] is `art` (scenic_art.ts)
    level_num: string | number;
    flag: string;
    seen_flag?: string; // (outside a career the game's level select locks by it, and hides nothing)
    hide_when_locked?: true;
    game_tag?: string;
    generic_art?: true;
}

export interface FrontendSection {
    id: string;
    tab: string;
    title: string;
    colour: string;
    levels: FrontendLevel[];
}

// The top-level { ... } elements of the array `name = [ ... ]` in NeverScript text (null: no such array).
export function arrayEntries(text: string, name: string): string[] | null {
    const found = new RegExp(`(^|\\n)${reEscape(name)} = \\[`, "i").exec(text);
    if (!found) return null;
    let i = found.index + found[0].length;
    const out: string[] = [];
    let depth = 0;
    let start = -1;
    for (; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            const end = text.indexOf('"', i + 1);
            if (end < 0) break;
            i = end;
        } else if (c === "{" || c === "[" || c === "(") {
            if (depth === 0 && c === "{") start = i;
            depth++;
        } else if (c === "}" || c === "]" || c === ")") {
            if (depth === 0) return out;
            depth--;
            if (depth === 0 && c === "}") out.push(text.slice(start, i + 1));
        }
    }
    throw new Error(`${name}: the array doesn't end`);
}

// A field of one entry: `key=value` (a quoted string's contents, else the word) - null when absent.
export function field(entry: string, key: string): string | null {
    const m = new RegExp(`(?:^|[\\s{])${reEscape(key)}=("([^"]*)"|[^\\s}]+)`, "i").exec(entry);
    if (!m) return null;
    return m[2] !== undefined ? m[2] : m[1]!;
}

export function hasFlag(entry: string, flag: string): boolean {
    return new RegExp(`(?:^|[\\s{])${reEscape(flag)}(?=[\\s}])`, "i").test(entry);
}

// The structures `<name> = { ... }` of Levels.qb as NeverScript text: where each starts and ends (end exclusive) and
// its text.
export function structureBlocks(levelsText: string): { start: number; end: number; body: string }[] {
    const out: { start: number; end: number; body: string }[] = [];
    const head = /(^|\n)(\w+) = \{/g;
    for (let m = head.exec(levelsText); m; m = head.exec(levelsText)) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        let end = -1;
        for (; i < levelsText.length; i++) {
            const c = levelsText[i];
            if (c === '"') {
                const q = levelsText.indexOf('"', i + 1);
                if (q < 0) break;
                i = q;
            } else if (c === "{") depth++;
            else if (c === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end < 0) break;
        out.push({ start: m.index, end: end + 1, body: levelsText.slice(m.index, end + 1) });
        head.lastIndex = end + 1;
    }
    return out;
}

// Each level structure's load script (lower case) -> its loading_screen, from Levels.qb as NeverScript text: the
// structures with both fields.
export function loadingScreens(levelsText: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const { body } of structureBlocks(levelsText)) {
        const load = field(body, "load_script");
        const screen = field(body, "loading_screen");
        if (load && screen) out.set(load.toLowerCase(), screen);
    }
    return out;
}

// The sections for the DLL, from the final level select and Levels.qb texts.
export function frontendSections(
    sectionList: readonly Section[],
    selectText: string,
    levelsText: string,
    frontArt: ReadonlyMap<string, string> = new Map(),
    artVariants: ReadonlyMap<string, readonly string[]> = new Map(), // load script (lower case) -> picture names
): FrontendSection[] {
    const screens = loadingScreens(levelsText);
    const out: FrontendSection[] = [];
    for (const [id, title, arrayName] of sectionList) {
        const entries = arrayEntries(selectText, arrayName);
        if (!entries) throw new Error(`level select: ${arrayName} (section ${id}) not found`);
        const style = SECTION_STYLE.get(id) ?? { tab: id.toUpperCase(), colour: "#C9CBD0" };
        let generic = 0;
        const levels: FrontendLevel[] = [];
        for (const entry of entries) {
            const name = field(entry, "text");
            const load = field(entry, "level");
            if (!name || !load) continue;
            // (frontArt: a level's text-free picture for the level select, frontend_art.ts; the loading screen keeps its own)
            let art = frontArt.get(load.toLowerCase()) ?? screens.get(load.toLowerCase()) ?? GENERIC_ART;
            const isGeneric = art.toLowerCase() === GENERIC_ART;
            if (isGeneric) art = `${GENERIC_ART}_${(generic++ % GENERIC_ART_COUNT) + 1}`;
            const levelNum = field(entry, "level_num") ?? "0";
            const level: FrontendLevel = {
                name,
                load,
                art,
                level_num: /^-?\d+$/.test(levelNum) ? Number(levelNum) : levelNum,
                flag: field(entry, "flag") ?? "",
            };
            const seen = field(entry, "seen_flag");
            if (seen) level.seen_flag = seen;
            if (hasFlag(entry, "hide_when_locked")) level.hide_when_locked = true;
            const tag = field(entry, "game_tag");
            if (tag) level.game_tag = tag;
            if (isGeneric) level.generic_art = true;
            const variants = artVariants.get(load.toLowerCase());
            if (variants && variants.length > 1 && variants[0] === art) level.art_variants = [...variants];
            levels.push(level);
        }
        if (levels.length) out.push({ id, tab: style.tab, title, colour: style.colour, levels });
    }
    return out;
}

export function frontendJson(sections: readonly FrontendSection[]): string {
    return `${JSON.stringify({ version: 1, menu_art: MENU_ART, sections }, null, 1)}\n`;
}
