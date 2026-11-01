// NOT ORIGINAL - runs a tool of an installed level converter or of thug2-level-converter-core by its path in that
// repository, as if it were run from a clone of it:
//
//   node tools/pipeline/run.ts thps3_levels/thps3_levels.ts convert --thug2 C:\Games\THUG2
//   node tools/pipeline/run.ts level_port/zfight.ts <levels folder>
//
// The tools are each repository's "commands" (its package.json); the first folder of the path names the repository
// (FOLDERS: from the commands of this repository's dependencies). The tool is the .js npm built beside the .ts in
// node_modules (Node strips no types there - thug2-level-converter-core's README, "Using it"), started with the rest
// of the command line as its own.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Manifest {
    dependencies?: Record<string, string>;
    commands?: string[];
}

const require = createRequire(import.meta.url);
const manifest = (file: string): Manifest => JSON.parse(fs.readFileSync(file, "utf-8")) as Manifest;
const packageFile = (pkg: string): string => require.resolve(`${pkg}/package.json`);

// Each installed repository's commands, by its folders: "thps3_levels" -> "thug2-thps3-level-converter".
export const COMMANDS: ReadonlyMap<string, string> = new Map(
    Object.keys(manifest(path.join(import.meta.dirname, "package.json")).dependencies ?? {})
        .filter((pkg) => pkg.startsWith("thug2-"))
        .flatMap((pkg) => (manifest(packageFile(pkg)).commands ?? []).map((c) => [c, pkg] as const)),
);
export const FOLDERS: Readonly<Record<string, string>> = Object.fromEntries(
    [...COMMANDS].map(([c, pkg]) => [c.split("/")[0]!, pkg]),
);

// "thps3_levels/thps3_levels.ts" -> the tool's .js in its installed package (null: not one of the commands).
export function toolFile(tool: string): string | null {
    const rel = tool.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\.js$/, ".ts");
    const pkg = COMMANDS.get(rel);
    if (pkg === undefined) return null;
    return path.join(path.dirname(packageFile(pkg)), rel.replace(/\.ts$/, ".js"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [tool, ...args] = process.argv.slice(2);
    const file = tool ? toolFile(tool) : null;
    if (file === null) {
        process.stderr.write(
            `usage: node run.ts <folder>/<tool>.ts [args...]\n  tools:\n${[...COMMANDS.keys()].map((c) => `    ${c}\n`).join("")}`,
        );
        process.exit(2);
    }
    // (the tool sees itself as the script run: its isMain / helpFromHeader / argv read as from a clone)
    process.argv = [process.argv[0]!, file, ...args];
    await import(pathToFileURL(file).href);
}
