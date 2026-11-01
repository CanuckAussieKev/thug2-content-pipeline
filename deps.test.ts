// NOT ORIGINAL - tests of the installed dependencies: every converter (run.ts's FOLDERS) is there, and they all use
// the one thug2-level-converter-core this repository uses - two copies would be two sets of classes (a Struct of one
// isn't one of the other's), so every package.json must pin the same commit of it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FOLDERS, toolFile } from "./run.ts";

const CORE = "thug2-level-converter-core";
const corePackage = (from: string): string => fs.realpathSync(createRequire(from).resolve(`${CORE}/package.json`));

test("one thug2-level-converter-core for the pipeline and every converter", () => {
    const ours = corePackage(fileURLToPath(import.meta.url));
    for (const pkg of new Set(Object.values(FOLDERS))) {
        if (pkg === CORE) continue;
        const own = fs.realpathSync(createRequire(import.meta.url).resolve(`${pkg}/package.json`));
        assert.equal(corePackage(own), ours, `${pkg} has a thug2-level-converter-core of its own: pin the same commit`);
    }
});

test("run.ts finds each repository's tools as the .js npm built", () => {
    for (const tool of ["thps3_levels/thps3_levels.ts", "level_port/zfight.ts", "thp8_save/thp8_save.ts"]) {
        const file = toolFile(tool);
        assert.ok(file?.endsWith(".js") && fs.existsSync(file), `${tool}: ${file}`);
    }
    assert.equal(toolFile("menu_level/make_menu_level.ts"), null);
});
