// NOT ORIGINAL - what the retail export (retail_export.ts) adds to THUG2's own scripts for the converted levels, as
// insertions (script_merge.ts) into the user's current files - nothing of this project's engine: no LevelEditor_*
// commands, no level select sections, no loading screens made from the level select's pictures.
//   scripts\game\levels.qb       each level's load script and level structure (thug2-level-converter-core's
//                                ported_levels.levelsQbText) - with the export's --pre, pre= / scnpre= / colpre=
//                                naming its archives as THUG2's own levels (<level>_scripts.pre, <level>scn.pre,
//                                <level>col.pre - the names load_level asks for in network games) - and its loading
//                                picture when there is one.
//   scripts\game\menu\gamemenu_levelselect.qb  a sign per level at the end of level_select_menu_level_info - THUG2's
//                                own level list, which is also the one the game looks a level's name up in online -
//                                with a THUG2 sign picture that suits it; and, at the start of the info panel's
//                                level_select_info_add_gaps / level_select_info_add_highscore, a return for each of
//                                their level numbers (they have no career records: reading them crashes the game).

import type { LevelEntry } from "thug2-level-converter-core/level_port/ported_levels.ts";
import { levelsQbText, loadOf, structName } from "thug2-level-converter-core/level_port/ported_levels.ts";
import { afterLine, type Insertion, MergeError } from "./script_merge.ts";

export const LEVELS_QB = "scripts\\game\\levels.qb";
export const LEVEL_SELECT_QB = "scripts\\game\\menu\\gamemenu_levelselect.qb";

// THUG2's level select sign pictures (sprites.qb's sign_*: loaded with the level select); any other icon -> training's.
export const THUG2_SIGNS: ReadonlySet<string> = new Set([
    "sign_airport",
    "sign_australia",
    "sign_barcelona",
    "sign_berlin",
    "sign_boston",
    "sign_canada",
    "sign_jam",
    "sign_neworleans",
    "sign_philly",
    "sign_school",
    "sign_secret1",
    "sign_secret2",
    "sign_skatopia",
    "sign_training",
]);

// A level's archives, as THUG2 names its own (load_level in network games asks for <level> + "scn.pre" / "col.pre").
export function archiveNames(level: string): { scripts: string; scene: string; collision: string } {
    return { scripts: `${level}_scripts.pre`, scene: `${level}scn.pre`, collision: `${level}col.pre` };
}

// The levels' structures for Levels.qb: ported_levels' text with the archive keys after level= and the loading picture
// (`art`: load script, lower case -> picture name) in place of loadscrn_generic.
export function levelsText(
    entries: readonly LevelEntry[],
    art: ReadonlyMap<string, string>,
    archives: boolean,
): string {
    let text = levelsQbText({ levels: [...entries] });
    for (const e of entries) {
        const struct = structName(e);
        const start = text.indexOf(`\n${struct} = {\n`);
        const end = text.indexOf("\n} \n", start);
        if (start < 0 || end < 0) throw new MergeError(`${struct}: not in the generated text`);
        let body = text.slice(start, end);
        if (archives) {
            const names = archiveNames(e.level);
            const levelLine = `\n    level="${e.level}" `;
            if (!body.includes(levelLine)) throw new MergeError(`${struct}: no level= line`);
            body = body.replace(
                levelLine,
                () =>
                    `${levelLine}\n    pre="${names.scripts}" \n    scnpre="${names.scene}" \n    colpre="${names.collision}" `,
            );
        }
        const picture = art.get(`load_${loadOf(e)}`.toLowerCase());
        if (picture) body = body.replace('loading_screen="loadscrn_generic"', () => `loading_screen="${picture}"`);
        text = text.slice(0, start) + body + text.slice(end);
    }
    return text;
}

// Where a top-level definition `name = ` or `script name ` is in the text (any case), or -1.
export function definitionAt(text: string, name: string): number {
    const re = new RegExp(`(^|\\n)(script ${name}\\b|${name} = )`, "i");
    const m = re.exec(text);
    return m ? m.index + m[1]!.length : -1;
}

// Levels.qb's insertion: the levels' structures before Load_TestLevel (where THUG2's test levels are), else at the end
// (before its checksum list). Refused if the file already defines one of their names (another mod's level of that name).
export function levelsInsertion(
    text: string,
    entries: readonly LevelEntry[],
    art: ReadonlyMap<string, string>,
    archives: boolean,
): Insertion {
    for (const e of entries) {
        for (const name of [structName(e), `Load_${loadOf(e)}`]) {
            if (definitionAt(text, name) >= 0) {
                throw new MergeError(`levels.qb already defines ${name} (a level of that name from somewhere else)`);
            }
        }
    }
    const added = levelsText(entries, art, archives);
    const anchor = definitionAt(text, "Load_TestLevel");
    if (anchor >= 0) return { at: anchor, text: added };
    const register = text.search(/(^|\n)__register_checksums__/);
    if (register >= 0) return { at: register + (text[register] === "\n" ? 1 : 0), text: added };
    if (text === "" || text.endsWith("\n")) return { at: text.length, text: added };
    throw new MergeError("levels.qb: neither Load_TestLevel nor a place at the end to add the levels");
}

export function signText(e: LevelEntry): string {
    const icon = typeof e.icon === "string" && THUG2_SIGNS.has(e.icon.toLowerCase()) ? e.icon : "sign_training";
    const number = Math.trunc(Number(e.level_num));
    return (
        `    {text="${e.display.replaceAll('"', "")}" level_num=${number} num_goals=0 flag=LEVEL_UNLOCKED_TR ` +
        `level=Load_${loadOf(e)} sign_texture=${icon} dot_pos=(89.0, 82.0)} \n`
    );
}

// The level select's insertions: the signs at the end of level_select_menu_level_info; the info panel's returns.
export function levelSelectInsertions(text: string, entries: readonly LevelEntry[]): Insertion[] {
    const out: Insertion[] = [];
    const list = /(^|\n)level_select_menu_level_info = \[\n/.exec(text);
    if (!list) throw new MergeError("gamemenu_levelselect.qb: level_select_menu_level_info not found");
    const close = text.indexOf("\n] ", list.index + 1);
    if (close < 0) throw new MergeError("gamemenu_levelselect.qb: the end of level_select_menu_level_info not found");
    const listText = text.slice(list.index, close);
    for (const e of entries) {
        if (
            listText.includes(`level=Load_${loadOf(e)} `) ||
            new RegExp(`level_num=${Math.trunc(Number(e.level_num))}\\b`).test(listText)
        ) {
            throw new MergeError(
                `gamemenu_levelselect.qb: the level list already has Load_${loadOf(e)} or level number ${e.level_num}`,
            );
        }
    }
    out.push({ at: close + 1, text: entries.map(signText).join("") });
    const numbers = [...new Set(entries.map((e) => Math.trunc(Number(e.level_num))))].sort((a, b) => a - b);
    const skips = numbers.map((n) => `    if (<level_num> = ${n}) {\n        return \n    } \n`).join("");
    for (const script of ["level_select_info_add_gaps", "level_select_info_add_highscore"]) {
        const at = definitionAt(text, script);
        if (at < 0)
            throw new MergeError(
                `gamemenu_levelselect.qb: ${script} not found (the info panel would crash on our levels)`,
            );
        out.push({ at: afterLine(text, at), text: skips });
    }
    return out;
}

// A whole file the export replaces (THUG1's driving scripts): only where the game's own is empty - THUG2 ships
// player_controlled_vehicle.qb and misc\car_scripts.qb empty; one with anything in it is the user's (a mod's) and is
// never replaced.
export function isEmptyScript(data: Uint8Array): boolean {
    for (const byte of data) {
        if (byte === 0x00) return true; // (end of file)
        if (byte !== 0x01) return false; // (anything but line ends)
    }
    return true;
}
