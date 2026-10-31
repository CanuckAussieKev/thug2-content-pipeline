// NOT ORIGINAL - tests of art_picks.ts: the decided pictures' file, the placeholder, the strength trial's blend and
// the levels.json labels.

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { PICKS_FILE, type PicksFile, parsePicks, placeholderPicture, readPicks } from "./art_picks.ts";
import { frontendSections } from "./frontend_levels.ts";
import type { Section } from "./level_select.ts";
import { blendPictures } from "./scenic_art.ts";

test("art_picks.json: 99 levels, the decided counts, Boston's trial", () => {
    const picks = readPicks();
    assert.equal(picks.size, 99);
    const placeholders = [...picks.values()].filter((p) => p.placeholder).length;
    const chosen = [...picks.values()].filter((p) => !p.placeholder);
    assert.equal(chosen.length + placeholders, 99);
    assert.equal(chosen.length, 45);
    assert.equal(placeholders, 54);
    assert.ok(chosen.every((p) => p.variant >= 0 && p.variant <= 3));
    assert.deepEqual(picks.get("load_bo")?.strengths, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.equal(picks.get("load_bo")?.variant, 2);
    assert.equal(picks.get("load_ba")?.placeholder, true);
    assert.equal(picks.get("load_tr")?.variant, 1);
    // only Boston has strengths
    assert.equal([...picks.values()].filter((p) => p.strengths).length, 1);
});

test("art_picks.json: every level of the sections is named once, with its game", () => {
    const file = JSON.parse(fs.readFileSync(PICKS_FILE, "utf-8")) as PicksFile;
    for (const [load, e] of Object.entries(file.levels)) {
        assert.equal(load, load.toLowerCase());
        assert.ok(e.game && e.name);
    }
    assert.ok(
        Object.values(file.levels)
            .filter((e) => e.game === "misc")
            .every((e) => e.pick === "placeholder"),
    );
});

test("parsePicks rejects bad data", () => {
    assert.throws(() => parsePicks({ version: 1, levels: { a: { game: "x", name: "A", pick: -1 } } }));
    assert.throws(() => parsePicks({ version: 1, levels: { a: { game: "x", name: "A", pick: 0, strengths: [0] } } }));
});

test("the placeholder: deterministic, opaque, dark, with the yellow rule and no scenic content", () => {
    const a = placeholderPicture(160, 90);
    assert.ok(a.bgra.equals(placeholderPicture(160, 90).bgra));
    let sum = 0;
    for (let i = 0; i < a.bgra.length; i += 4) {
        assert.equal(a.bgra[i + 3], 255);
        sum += a.bgra[i]! + a.bgra[i + 1]! + a.bgra[i + 2]!;
    }
    assert.ok(sum / (160 * 90 * 3) < 40, "mostly ink");
    // the rule's pixel is yellow (red and green high, blue low)
    const x = Math.round(((640 - 26 - 28) / 640) * 160);
    const y = Math.round(((360 - 26 - 1.5) / 360) * 90);
    const o = (y * 160 + x) * 4;
    assert.ok(a.bgra[o + 2]! > 200 && a.bgra[o + 1]! > 200 && a.bgra[o]! < 40);
});

test("blendPictures: 0 is the base, 1 the top, halfway between", () => {
    const base = { width: 2, height: 1, bgra: Buffer.from([0, 0, 0, 255, 100, 100, 100, 255]) };
    const top = { width: 2, height: 1, bgra: Buffer.from([200, 100, 50, 255, 200, 200, 200, 255]) };
    assert.ok(blendPictures(base, top, 0).bgra.equals(base.bgra));
    assert.ok(blendPictures(base, top, 1).bgra.equals(top.bgra));
    assert.deepEqual([...blendPictures(base, top, 0.5).bgra], [100, 50, 25, 255, 150, 150, 150, 255]);
});

test("frontendSections: the labels come with the variants; the loading picture may be any of them", () => {
    const list: Section[] = [["thug2", "THUG2", "arr", null]];
    const select = 'arr = [\n {text="A" level_num=1 flag=F level=load_a}\n]\n';
    const levels = 'Level_a = {\n load_script=load_a\n loading_screen="pic"\n}\n';
    const variants = new Map([["load_a", ["pic_s10", "pic_s20", "pic"]]]);
    const labels = new Map([["load_a", ["10%", "20%", "100%"]]]);
    const art = new Map([["load_a", "pic"]]);
    const sections = frontendSections(list, select, levels, art, variants, labels);
    const level = sections[0]?.levels[0];
    assert.deepEqual(level?.art_variants, ["pic_s10", "pic_s20", "pic"]);
    assert.deepEqual(level?.art_labels, ["10%", "20%", "100%"]);
    assert.equal(level?.art, "pic");
});
