// NOT ORIGINAL - tests of the THUG1 campaign survey's script walker (script_gap.ts), on hand-made THUG2 tokens.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum } from "../level_port/qb.ts";
import { pack } from "../lib/struct.ts";
import { ScriptSet, stubs, subsystem } from "./script_gap.ts";

const name = (text: string): Buffer => Buffer.concat([Buffer.from([0x16]), pack("<I", checksum(text))]);
const b = (...bytes: number[]): Buffer => Buffer.from(bytes);
const nl = b(0x01);
const EQ = b(0x07);
const script = (scriptName: string, ...body: Buffer[]): Buffer =>
    Buffer.concat([b(0x23), name(scriptName), nl, ...body, b(0x24), nl]);

test("commands, their parameters over several lines, members and assignments", () => {
    const data = Buffer.concat([
        // CreateScreenElement { id=Box  \n  parent=root }  - the unnamed structure's entries are the parameters
        script(
            "Make",
            name("CreateScreenElement"),
            b(0x03),
            name("id"),
            EQ,
            name("Box"),
            nl,
            name("parent"),
            EQ,
            name("root"),
            b(0x04),
            nl,
            // count = 1: an assignment, not a call
            name("count"),
            EQ,
            b(0x17),
            pack("<i", 1),
            nl,
            // Skater:Obj_PlayAnim anim=Idle Cycle
            name("Skater"),
            b(0x42),
            name("Obj_PlayAnim"),
            name("anim"),
            EQ,
            name("Idle"),
            name("Cycle"),
            nl,
            // if GotParam x  -> GotParam is a command; Helper a script reference
            b(0x25),
            name("GotParam"),
            name("x"),
            nl,
            name("SpawnScript"),
            name("Helper"),
            nl,
            b(0x28),
            nl,
        ),
        script("Helper", name("Wait"), b(0x17), pack("<i", 1), nl),
        // a global naming a script
        name("Table"),
        EQ,
        b(0x03),
        name("callback"),
        EQ,
        name("Helper"),
        b(0x04),
        nl,
        b(0x00),
    ]);
    const set = new ScriptSet();
    set.add("scripts\\test.qb", data);
    assert.deepEqual([...set.scripts.keys()].sort(), [checksum("Make"), checksum("Helper")].sort());
    assert.ok(set.globals.has(checksum("Table")));
    const calls = set.calls.get(checksum("Make"))!;
    assert.deepEqual(
        calls.map((c) => c.name),
        ["CreateScreenElement", "Obj_PlayAnim", "GotParam", "SpawnScript"].map(checksum),
    );
    assert.deepEqual([...calls[0]!.params].sort(), [checksum("id"), checksum("parent")].sort());
    assert.equal(calls[1]!.member, true);
    assert.deepEqual([...calls[1]!.params], [checksum("anim")]);
    assert.ok(calls[1]!.flags.has(checksum("Cycle")));
    assert.ok(set.valueRefs.get(checksum("Make"))!.has(checksum("Helper")));
    assert.ok(set.valueRefs.get(checksum("Table"))!.has(checksum("Helper")));
    assert.ok(set.keys.has(checksum("callback")));
});

test("stubs are the functions ten names share", () => {
    const rows: [string, number][] = Array.from({ length: 10 }, (_, i): [string, number] => [`Stub${i}`, 0x100]);
    rows.push(["Real", 0x200]);
    const s = stubs(rows);
    assert.ok(s.has(checksum("Stub3")));
    assert.ok(!s.has(checksum("Real")));
});

test("subsystems by name, then by file", () => {
    assert.equal(subsystem("PlayCutscene", []), "cutscenes / movies");
    assert.equal(subsystem("GoalManager_AdvanceStage", []), "goals");
    assert.equal(subsystem("Frobnicate", ["scripts\\game\\menu\\chapter_info.qb"]), "story / progression");
    assert.equal(subsystem("Frobnicate", []), "engine / misc");
});
