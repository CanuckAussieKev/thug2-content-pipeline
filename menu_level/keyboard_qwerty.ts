// Note: the script text handled below is THUG2's own on-screen keyboard script (engine\menu\keyboard.qb), changed here;
// the original script belongs to its rights holders (see the notice in README.md), not to this project.
// NOT ORIGINAL - the on-screen keyboard as a QWERTY keyboard (the user's request): the keys the controller types with
// (skater / park / goal names, chat, server names...) in the order of a console's keyboard instead of A to Z.
//
// The game's keyboard script builds 4 rows of keys (keyboard_create_key_sprites: 10 + 10 + 10 + 6 keys, the last row
// ending with the wide Backspace key) and fills them from four character sets (keyboard_change_charset): lower case,
// upper case, symbols and foreign letters, each an array of 4 rows. Here the rows are 10 + 10 + 9 + 7 keys:
//
//     1 2 3 4 5 6 7 8 9 0
//     q w e r t y u i o p
//     a s d f g h j k l
//     z x c v b n m [Backspace]
//
// The symbols and the foreign letters keep their order (the same 36 characters, in rows of 10, 10, 9, 7), so every
// character that was there still is. Navigation is the game's own: a vertical step lands on the key whose tag_grid_x
// is the last at most the one left (keyboard_change_key_row sets it to the key's column; the Backspace key is given
// column 7 as it follows 7 keys), so the shorter rows work and the move wraps at the ends as before.
// Used by make_menu_level.ts for the data overlay's scripts\engine\menu\keyboard.qb and for Anteara Mod's copy of it.
//
// The keys only exist with PartyMod's change to the script: THUG2's own PC keyboard is a text box (the typed text, the
// helper line, no keys - create_onscreen_keyboard never calls keyboard_create_key_sprites). The game applies PartyMod's
// binary patch (partymod_keyboard.bps, PartyMod's patches/keyboard.bps - MIT, THIRD_PARTY_NOTICES.md) when it loads
// the file, but only to the very file it was made for (its size and CRC-32): an overlay's own keyboard.qb is loaded as
// it is. So the overlay's starts from the patched script (partyModKeyboard), and Anteara Mod's, made from the loose
// script, gets the scripts the patch changes (partyModScripts).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBps, bpsMadeFor } from "../lib/bps.ts";
import { countOf, replaceFirst } from "./level_select.ts";

const PARTYMOD_PATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "partymod_keyboard.bps");

// The game's compiled keyboard.qb with PartyMod's patch applied, or null when it isn't the file the patch is for.
export function partyModKeyboard(
    compiled: Uint8Array,
    patch: Uint8Array = fs.readFileSync(PARTYMOD_PATCH),
): Buffer | null {
    return bpsMadeFor(patch, compiled) ? applyBps(patch, compiled) : null;
}

// A script's text: its "script <name>" line to the "}" closing it (both at the start of a line).
function scriptAt(text: string, name: string): { start: number; end: number } | null {
    const head = new RegExp(`^script ${name}\\b[^\\n]*\\{`, "m").exec(text);
    if (!head) return null;
    const close = /^\} *$/m.exec(text.slice(head.index));
    return close ? { start: head.index, end: head.index + close.index + close[0].length } : null;
}
function scriptNames(text: string): string[] {
    return [...text.matchAll(/^script (\S+)/gm)].map((m) => m[1]!);
}
// (printf lines aside: the archived scripts were compiled without them, the loose ones with)
const comparable = (unit: string): string =>
    unit
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "" && !/^\s*printf\b/.test(line))
        .join("\n");

// text (a keyboard script made from the game's): the scripts PartyMod's patch changes (game -> patched, both
// decompiled) put in, each where text has the game's own; null when one of them differs in text (changed by a mod).
export function partyModScripts(text: string, game: string, patched: string): string | null {
    [text, game, patched] = [text, game, patched].map((t) => t.replace(/\r\n?/g, "\n")) as [string, string, string];
    for (const name of scriptNames(patched)) {
        const was = scriptAt(game, name);
        const now = scriptAt(patched, name)!;
        const nowText = patched.slice(now.start, now.end);
        if (was && comparable(game.slice(was.start, was.end)) === comparable(nowText)) continue;
        const here = scriptAt(text, name);
        if (
            !was ||
            !here ||
            comparable(text.slice(here.start, here.end)) !== comparable(game.slice(was.start, was.end))
        )
            return null;
        text = text.slice(0, here.start) + nowText + text.slice(here.end);
    }
    return text;
}

const ROW_SIZES = [10, 10, 9, 7];
const LETTER_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

const CHARSETS = ["alphanumeric_charset_lower", "alphanumeric_charset_upper", "punctuation_charset", "foreign_charset"];

function once(text: string, old: string, what: string): void {
    const n = countOf(text, old);
    if (n !== 1) throw new Error(`keyboard.qb: ${what} found ${n} times`);
}

// A character set's array text: the digits row and the rows of the 36 keys.
function charsetText(name: string, rows: string[][]): string {
    const lines = rows.map((row) => `[${row.map((key) => `"${key}"`).join(" ")}]`);
    return `${name} = [${lines.join(" \n    ")} \n] `;
}

// keys: the 36 keys of a set in the order they were typed, cut into the new rows.
function reflow(keys: string[]): string[][] {
    const rows: string[][] = [];
    let at = 0;
    for (const size of ROW_SIZES) {
        rows.push(keys.slice(at, at + size));
        at += size;
    }
    return rows;
}

export function qwertyKeyboard(text: string): string {
    // The rows and the Backspace key.
    const rows3 = "keyboard_add_generic_buttons_to_hmenu hmenu_id=keyboard_row_3 number_of_buttons=10";
    const rows4 = "keyboard_add_generic_buttons_to_hmenu hmenu_id=keyboard_row_4 number_of_buttons=6";
    once(text, rows3, "row 3");
    once(text, rows4, "row 4");
    text = replaceFirst(text, rows3, rows3.replace("=10", "=9"));
    text = replaceFirst(text, rows4, rows4.replace("=6", "=7"));
    const backKey = /(text="Backspace"[^}]*?grid_x=)6\b/;
    if (!backKey.test(text)) throw new Error("keyboard.qb: the Backspace key not found");
    text = text.replace(backKey, (_all, head: string) => `${head}7`);

    // The character sets.
    for (const name of CHARSETS) {
        const match = new RegExp(`^${name} = \\[[\\s\\S]*?^\\] *\\r?$`, "m").exec(text);
        if (!match) throw new Error(`keyboard.qb: ${name} not found`);
        const keys = match[0].match(/"[^"]*"/g)?.map((key) => key.slice(1, -1)) ?? [];
        if (keys.length !== 36) throw new Error(`keyboard.qb: ${name} has ${keys.length} keys, not 36`);
        let rows: string[][];
        if (name === "alphanumeric_charset_lower") rows = [DIGITS, ...LETTER_ROWS.map((row) => [...row])];
        else if (name === "alphanumeric_charset_upper")
            rows = [DIGITS, ...LETTER_ROWS.map((row) => [...row.toUpperCase()])];
        else rows = reflow(keys);
        text = text.slice(0, match.index) + charsetText(name, rows) + text.slice(match.index + match[0].length);
    }
    return text;
}
