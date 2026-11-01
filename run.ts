// NOT ORIGINAL - runs a tool of an installed level converter or of thug2-level-converter-core by its path in that
// repository, as if it were run from a clone of it:
//
//   node tools/pipeline/run.ts thps3_levels/thps3_levels.ts convert --thug2 C:\Games\THUG2
//   node tools/pipeline/run.ts level_port/zfight.ts <levels folder>
//
// The first folder names the repository (FOLDERS); the tool is the .js npm built beside the .ts in node_modules
// (Node strips no types there - thug2-level-converter-core's README, "Using it"), started with the rest of the
// command line as its own.

import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FOLDERS: Readonly<Record<string, string>> = {
    lib: "thug2-level-converter-core",
    level_port: "thug2-level-converter-core",
    compat: "thug2-level-converter-core",
    thaw: "thug2-level-converter-core",
    thp8: "thug2-level-converter-core",
    thps2_levels: "thug2-thps2-level-converter",
    thps3_levels: "thug2-thps3-level-converter",
    thps4_levels: "thug2-thps4-level-converter",
    thug1_levels: "thug2-thug1-level-converter",
    thug1_campaign: "thug2-thug1-level-converter",
    thaw_levels: "thug2-thaw-level-converter",
    thp8_levels: "thug2-thp8-level-converter",
    thp8_save: "thug2-thp8-level-converter",
    thpg_levels: "thug2-thpg-level-converter",
};

// "thps3_levels/thps3_levels.ts" -> the file's path in its installed package (null: no such folder).
export function toolFile(tool: string): string | null {
    const rel = tool.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\.js$/, ".ts");
    const pkg = FOLDERS[rel.split("/")[0]!];
    if (pkg === undefined || !rel.endsWith(".ts")) return null;
    return fileURLToPath(import.meta.resolve(`${pkg}/${rel}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [tool, ...args] = process.argv.slice(2);
    const file = tool ? toolFile(tool) : null;
    if (file === null) {
        process.stderr.write(
            `usage: node run.ts <folder>/<tool>.ts [args...]  (folders: ${Object.keys(FOLDERS).join(", ")})\n`,
        );
        process.exit(2);
    }
    // (the tool sees itself as the script run: its isMain / helpFromHeader / argv read as from a clone)
    process.argv = [process.argv[0]!, file, ...args];
    await import(pathToFileURL(file).href);
}
