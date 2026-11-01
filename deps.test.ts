// NOT ORIGINAL - the dependency rules of the level converters' repositories, checked on what npm installed:
//
//   - the edges follow the engines (ALLOWED): a converter depends on thug2-level-converter-core and on the converters
//     of the games its game is built on - Project 8 on THAW's formats, Proving Ground on Project 8's engine - never
//     the other way round, and on thug2-thugpro-compat when it uses THUGPRO's profile (that one only on core); core
//     depends on none, and nothing on this repository; the graph has no cycle;
//   - one copy of each: every package.json that names a repository pins the same commit of it (two copies would be
//     two sets of classes - a Struct of one isn't one of the other's), and npm installed one;
//   - every import of a repository names one of its exports (no reaching into another repository's internals) and a
//     dependency of the importer - in every installed repository and in this one (thug2-level-converter-core's
//     lib/package_check.ts, which each repository's own package.test.ts runs too);
//   - run.ts finds each repository's commands.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
    installedPackage,
    OUR_PACKAGE,
    type PackageJson,
    PIN,
    packageProblems,
    readPackage,
} from "thug2-level-converter-core/lib/package_check.ts";
import { COMMANDS, FOLDERS, toolFile } from "./run.ts";

const CORE = "thug2-level-converter-core";
const THAW = "thug2-thaw-level-converter";
const THP8 = "thug2-thp8-level-converter";
const COMPAT = "thug2-thugpro-compat"; // (THUGPRO's compatibility profile: the register and its data)

// What each repository may depend on (specific -> general; core at the bottom).
export const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    [CORE]: [],
    [COMPAT]: [CORE], // a profile is data on core's mechanism - no converter's code
    "thug2-thps2-level-converter": [CORE],
    "thug2-thps3-level-converter": [CORE, COMPAT],
    "thug2-thps4-level-converter": [CORE, COMPAT],
    "thug2-thug1-level-converter": [CORE, COMPAT],
    [THAW]: [CORE, COMPAT], // (Tony Hawk's American Wasteland)
    [THP8]: [CORE, THAW], // Project 8 reads THAW's formats (its level files, scripts, node flags)
    "thug2-thpg-level-converter": [CORE, THAW, THP8], // Proving Ground runs Project 8's engine with its own profile
};

const PIPELINE = import.meta.dirname;
const pipeline = readPackage(PIPELINE);

// Every repository installed here: name -> its folder and package.json.
const installed = new Map<string, { dir: string; pkg: PackageJson }>();
for (const name of Object.keys(pipeline.dependencies ?? {})) {
    if (!OUR_PACKAGE.test(name)) continue;
    const found = installedPackage(PIPELINE, name);
    assert.ok(found, `${name} is not installed: npm ci`);
    installed.set(name, found);
}
const ourDeps = (pkg: PackageJson): string[] => Object.keys(pkg.dependencies ?? {}).filter((d) => OUR_PACKAGE.test(d));

test("every converter repository is installed, and only those ALLOWED knows", () => {
    assert.deepEqual([...installed.keys()].sort(), Object.keys(ALLOWED).sort());
});

test("dependencies follow the engines: only ALLOWED edges, no cycle", () => {
    for (const [name, { pkg }] of installed) {
        for (const dep of ourDeps(pkg))
            assert.ok(ALLOWED[name]?.includes(dep), `${name} depends on ${dep}: not an allowed edge (ALLOWED)`);
    }
    const state = new Map<string, "open" | "done">();
    const visit = (name: string, trail: string[]): void => {
        if (state.get(name) === "done") return;
        assert.notEqual(state.get(name), "open", `a cycle: ${[...trail, name].join(" -> ")}`);
        state.set(name, "open");
        for (const dep of ourDeps(installed.get(name)?.pkg ?? { name })) visit(dep, [...trail, name]);
        state.set(name, "done");
    };
    for (const name of installed.keys()) visit(name, []);
});

test("one copy of each repository: every pin names the same commit, and npm installed one", () => {
    const pins = new Map<string, Map<string, string>>(); // repository -> pin -> who pins it so
    const dependents: [string, string, PackageJson][] = [
        ["thug2-content-pipeline", PIPELINE, pipeline],
        ...[...installed].map(([name, v]) => [name, v.dir, v.pkg] as [string, string, PackageJson]),
    ];
    const root = path.resolve(PIPELINE, "..", ".."); // (the decomp, when this is its tools/pipeline)
    if (fs.existsSync(path.join(root, "package.json")) && readPackage(root).name === "thug2-decomp-tools")
        dependents.push(["the decomp", root, readPackage(root)]);
    for (const [who, dir, pkg] of dependents) {
        for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
            if (!OUR_PACKAGE.test(dep)) continue;
            assert.match(
                spec,
                PIN,
                `${who}: ${dep} "${spec}" is not git+https://git@github.com/CanuckAussieKev/${dep}.git#<commit>`,
            );
            if (!pins.has(dep)) pins.set(dep, new Map());
            pins.get(dep)!.set(spec, who);
            const copy = installedPackage(dir, dep)?.dir;
            assert.equal(copy, installed.get(dep)?.dir, `${who} has a ${dep} of its own: pin the same commit`);
        }
    }
    for (const [dep, seen] of pins)
        assert.equal(
            seen.size,
            1,
            `${dep} pinned to different commits: ${[...seen].map(([s, w]) => `${w}: ${s}`).join("; ")}`,
        );
});

test("imports name exports of declared dependencies (every installed repository and this one)", () => {
    const problems = [PIPELINE, ...[...installed.values()].map((v) => v.dir)].flatMap((dir) =>
        packageProblems(dir).map((p) => `${readPackage(dir).name}: ${p}`),
    );
    assert.deepEqual(problems, []);
});

test("run.ts finds each repository's commands as the .js npm built", () => {
    for (const [command, pkg] of COMMANDS) {
        assert.equal(FOLDERS[command.split("/")[0]!], pkg, `${command}: its folder is another repository's too`);
        const file = toolFile(command);
        assert.ok(file?.endsWith(".js") && fs.existsSync(file), `${command}: ${file}`);
    }
    for (const tool of [
        "thps3_levels/thps3_levels.ts",
        "level_port/zfight.ts",
        "thp8_save/thp8_save.ts",
        "thugpro/scripts_hash.ts",
    ])
        assert.ok(COMMANDS.has(tool), tool);
    assert.equal(toolFile("menu_level/make_menu_level.ts"), null);
});
