// NOT ORIGINAL - tests of scenic_capture.ts's command list: the level waited for may differ from the spots file's key
// (THUG2's SkateShopLevel is the "mainmenu" scene; THPS4's skate shop is started as "practice").

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { levelCommands } from "./scenic_capture.ts";
import type { Candidate } from "./scenic_spots.ts";

const candidate = (id: number): Candidate => ({
    id,
    pose: { pos: [100, 200, 300], heading: 90, pitch: 40 },
    target: [0, 0, 0],
    score: {
        score: 1,
        interest: 0,
        rails: 0,
        spread: 0,
        depth: 0,
        sky: 0,
        void: 0,
        back: 0,
        near: 0,
        occl: 0,
        blocked: false,
    },
    ground: 50,
});

test("the commands wait for the start name and name the series by the level's key", () => {
    const cmds = levelCommands("thps4_skateshop", [candidate(2)], 45, "practice");
    assert.equal(cmds[0], "waitfor level practice 300");
    assert.ok(cmds.includes("capture 1 scenic_thps4_skateshop_2"));
    assert.equal(cmds[cmds.length - 1], "camera off");
    assert.equal(levelCommands("BO", [], 45)[0], "waitfor level BO 300");
});
