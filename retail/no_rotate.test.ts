// NOT ORIGINAL - tests of retail/no_rotate.ts: THAW's no_rotate locks made the original game's way, in a level's text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeAngles, retailNoRotate } from "./no_rotate.ts";

const LEVEL = `lvl_NodeArray = [
    {
        pos=(0.0, 0.0, 0.0)
        Angles=(0.0, 0.0, 0.0)
        Name=Wheel
    }
    {
        pos=(0.0, -10.0, 0.0)
        Name=Car01
    }
    {
        pos=(0.0, 10.0, 0.0)
        Angles=(0.0, 1.5, 0.0)
        Name=Tilted
    }
]
script WheelStart {
    if ISAlive Name=Car01 {
        Car01:Obj_LockToObject ObjectName=Wheel (-6.0, -10.0, 0.0) no_rotate
    }
    if ISAlive Name=Wheel {
        Wheel:Obj_RotX speed=15
    }
}
__register_checksums__ lvl_NodeArray Wheel Car01
`;

test("node angles found, or none", () => {
    const lines = LEVEL.split("\n");
    assert.deepEqual(nodeAngles(lines, "Wheel"), [0, 0, 0]);
    assert.deepEqual(nodeAngles(lines, "Car01"), [0, 0, 0]);
    assert.deepEqual(nodeAngles(lines, "Tilted"), [0, 1.5, 0]);
    assert.equal(nodeAngles(lines, "Nobody"), null);
});

test("the target turned by a script of ours, the locked objects turned back", () => {
    const r = retailNoRotate(LEVEL);
    assert.deepEqual(r.left, []);
    assert.deepEqual(r.done, ["Wheel (1 object(s))"]);
    assert.ok(!/no_rotate/.test(r.text));
    assert.match(r.text, /Car01:Obj_LockToObject ObjectName=Wheel \(-6\.0, -10\.0, 0\.0\) \n/);
    assert.match(r.text, /spawnscript retail_turn_Wheel \n/);
    assert.ok(!/Obj_RotX/.test(r.text));
    // (Obj_RotX speed=15: the absolute angle the other way round, -0.015 degrees a millisecond; ten turns 240 s)
    assert.match(r.text, /retail_turn_degrees = \(<ElapsedTime> \* -0\.015\)/);
    assert.match(r.text, /if \(<ElapsedTime> > 240000\)/);
    assert.match(r.text, /Wheel:Obj_Rotate absolute=\(\(1\.0, 0\.0, 0\.0\) \* <retail_turn_degrees>\) time=0/);
    assert.match(r.text, /retail_turn_back = \(\(0\.0174532925, 0\.0, 0\.0\) \* <retail_turn_degrees>\)/);
    assert.match(r.text, /Car01:Obj_LockToObject ObjectName=Wheel \(-6\.0, -10\.0, 0\.0\) Angles=<retail_turn_back>/);
    // (the script before the checksum list)
    assert.ok(r.text.indexOf("script retail_turn_Wheel") < r.text.indexOf("__register_checksums__"));
});

test("left as it is where it wouldn't be exact", () => {
    const tilted = LEVEL.replace("Car01:Obj_LockToObject", "Tilted:Obj_LockToObject").replace(
        "ISAlive Name=Car01",
        "ISAlive Name=Tilted",
    );
    const r = retailNoRotate(tilted);
    assert.deepEqual(r.done, []);
    assert.match(r.left[0] ?? "", /Tilted has node angles/);
    assert.equal(r.text, tilted);
    const twice = LEVEL.replace("Wheel:Obj_RotX speed=15", "Wheel:Obj_RotX speed=15 \n        Wheel:Obj_RotY speed=5");
    const t = retailNoRotate(twice);
    assert.deepEqual(t.done, []);
    assert.equal(retailNoRotate("script x {\n} \n").done.length, 0);
});
