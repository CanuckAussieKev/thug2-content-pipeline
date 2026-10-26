// NOT ORIGINAL - the standard main menu's scripts (make_menu_level.ts standardMainMenu; src/game/front/menu_backdrop.h),
// made from the user's THUG2 each run: main_menu.ns holds our own scripts and, for each one that is an adapted game
// script (create_main_menu, add_main_menu_list_items, main_menu_list_item - the game's create_main_menu /
// add_main_menu_items / make_spin_menu_item -, main_menu_choose and main_menu_skate_now - its main_menu_exit - and
// more: the units main_menu.edits names), a line "//@unit <name>"; main_menu.edits holds our changes to those
// (tools/pipeline/lib/edits.ts: line operations on the game's script, decompiled from Data\pre's qb_scripts.prx /
// mainmenu_scripts.prx with NeverScript). No game text is stored. To change one: `dump`, edit, `extract`.
//
//   node tools/pipeline/menu_level/main_menu.ts dump [--game C:\Games\THUG2] [--ns <ns.exe>] --out <file.ns>
//   node tools/pipeline/menu_level/main_menu.ts extract [--game C:\Games\THUG2] [--ns <ns.exe>] --from <file.ns>
//       (re)writes main_menu.ns and main_menu.edits from the whole text (and checks they give it back)

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NS_DEFAULT } from "../lib/decomp.ts";
import {
    applyOwnEdits,
    EditsError,
    formatEdits,
    ownEdits,
    parseEdits,
    UnitIndex,
    type UnitLookup,
    unitMap,
} from "../lib/edits.ts";
import { resolveInstall } from "../lib/install.ts";
import { isMain, print, runMain } from "../lib/py.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OWN = path.join(HERE, "main_menu.ns");
export const EDITS = path.join(HERE, "main_menu.edits");

// The game's archived scripts (the files of Data\pre's .prx archives, by name as stored), decompiled with NeverScript
// as they're asked for - by file name ("levels\mainmenu\mainmenu_scripts.qb", case and slashes ignored) and unit.
export class PrxScripts implements UnitLookup {
    private readonly files = new Map<string, Buffer>();
    private readonly units = new Map<string, Map<string, string>>();
    private readonly tool: string;
    private readonly work: string;

    constructor(archives: Iterable<ReadonlyMap<string, Buffer>>, tool: string, work: string) {
        for (const archive of archives) {
            for (const [name, data] of archive) this.files.set(fileKey(name), data);
        }
        this.tool = tool;
        this.work = work;
    }

    unit(file: string, key: string): string | undefined {
        return this.fileUnits(fileKey(file))?.get(key);
    }

    private fileUnits(file: string): Map<string, string> | undefined {
        let units = this.units.get(file);
        if (!units) {
            const data = this.files.get(file);
            if (!data) return undefined;
            const qb = path.join(this.work, `prx_${this.units.size}.qb`);
            fs.writeFileSync(qb, data);
            const result = spawnSync(this.tool, ["-d", qb, "-o", `${qb}.ns`]);
            if (result.error) throw result.error;
            units =
                result.status === 0
                    ? unitMap(fs.readFileSync(`${qb}.ns`).toString("latin1").replace(/\r\n?/g, "\n"))
                    : new Map();
            this.units.set(file, units);
        }
        return units;
    }

    // every unit: [file, key, text]
    *all(): Generator<readonly [string, string, string]> {
        for (const file of [...this.files.keys()]) {
            for (const [key, text] of this.fileUnits(file) ?? []) yield [file, key, text];
        }
    }
}

function fileKey(name: string): string {
    return name.toLowerCase().replaceAll("/", "\\");
}

function readLatin1(file: string): string {
    return fs.readFileSync(file).toString("latin1").replace(/\r\n?/g, "\n");
}

// The standard main menu's scripts (see above), made from the user's game scripts.
export function mainMenuScripts(look: UnitLookup): string {
    try {
        return applyOwnEdits(readLatin1(OWN), parseEdits(readLatin1(EDITS), "main_menu.edits"), look, "main menu");
    } catch (err) {
        if (err instanceof EditsError) throw new Error(`the standard main menu: ${err.message}`);
        throw err;
    }
}

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            game: { type: "string", default: "C:\\Games\\THUG2" },
            ns: { type: "string", default: NS_DEFAULT },
            out: { type: "string" },
            from: { type: "string" },
        },
    });
    // (make_menu_level.ts reads the archives; imported here, it imports this file)
    const { prxFiles } = await import("./make_menu_level.ts");
    const pre = path.join(resolveInstall(values.game!, "thug2"), "Data", "pre");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"));
    try {
        const look = new PrxScripts(
            ["qb_scripts.prx", "mainmenu_scripts.prx"].map((f) => prxFiles(path.join(pre, f))),
            values.ns!,
            work,
        );
        if (positionals[0] === "dump" && values.out) {
            fs.writeFileSync(values.out, Buffer.from(mainMenuScripts(look), "latin1"));
            print(`wrote ${values.out}`);
            return 0;
        }
        if (positionals[0] === "extract" && values.from) {
            const [own, edits] = ownEdits(
                readLatin1(values.from),
                new UnitIndex(look, look.all()),
                look,
                "main menu",
                "# The standard main menu's changes to the game's scripts (tools/pipeline/lib/edits.ts; main_menu.ts)",
                0.8,
                0.9,
            );
            fs.writeFileSync(OWN, Buffer.from(own, "latin1"));
            fs.writeFileSync(
                EDITS,
                Buffer.from(edits ? formatEdits(edits) : "# (no game scripts adapted)\n", "latin1"),
            );
            print(`wrote ${OWN} and ${EDITS}: ${edits?.blocks.length ?? 0} adapted game scripts as edits`);
            return 0;
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    process.stderr.write("usage: main_menu.ts dump --out <file.ns> | extract --from <file.ns> [--game ..] [--ns ..]\n");
    return 2;
}

// (not awaited at the top level: main imports make_menu_level.ts, which imports this module - it must be done loading)
if (isMain(import.meta.url)) void runMain(() => main(process.argv.slice(2)));
