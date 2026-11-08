// NOT ORIGINAL - tests of retail/limits_dll.ts: the limits DLL put beside THUG2.exe and taken out again, a dinput8.dll
// already there renamed and chained, the ini's chain= kept and given back.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
    CHAINED,
    chainOf,
    DLL,
    dllProblem,
    INI,
    isLimitsDll,
    LOG,
    planInstall,
    uninstall,
    uninstallProblems,
    withChain,
} from "./limits_dll.ts";

// A stand-in for a 32-bit DLL: an MZ / PE header and, for ours, the names a limits DLL has in it.
function fakeDll(machine: number, limits: boolean, tag = ""): Buffer {
    const b = Buffer.alloc(0x200);
    b.write("MZ", 0, "latin1");
    b.writeUInt32LE(0x80, 0x3c);
    b.writeUInt32LE(0x4550, 0x80);
    b.writeUInt16LE(machine, 0x84);
    if (limits) b.write(`${INI} ${LOG} ${tag}`, 0x100, "latin1");
    else b.write(`a mod ${tag}`, 0x100, "latin1");
    return b;
}

function folder(): { game: string; state: string } {
    const game = fs.mkdtempSync(path.join(os.tmpdir(), "limits-dll-"));
    return { game, state: path.join(game, "thug2-retail-export") };
}

test("a limits DLL is told from a mod's, and must be 32-bit", () => {
    assert.equal(isLimitsDll(fakeDll(0x14c, true)), true);
    assert.equal(isLimitsDll(fakeDll(0x14c, false)), false);
    assert.equal(dllProblem(fakeDll(0x14c, true)), null);
    assert.match(dllProblem(fakeDll(0x8664, true)) ?? "", /32-bit/);
    assert.match(dllProblem(fakeDll(0x14c, false)) ?? "", /not the retail-limits DLL/);
});

test("the ini's chain= set, added and read", () => {
    assert.equal(chainOf("[limits]\r\nenabled=1\r\n[loader]\r\nchain=\r\n"), "");
    assert.equal(
        withChain("[limits]\r\nenabled=1\r\n[loader]\r\nchain=\r\n", "x.dll"),
        "[limits]\r\nenabled=1\r\n[loader]\r\nchain=x.dll\r\n",
    );
    assert.equal(chainOf(withChain("[limits]\nenabled=0\n", "y.dll")), "y.dll");
    assert.equal(chainOf(withChain("[loader]\n; note\n", "z.dll")), "z.dll");
});

test("into a folder with no dinput8.dll and out again", () => {
    const { game, state } = folder();
    const ours = fakeDll(0x14c, true);
    const plan = planInstall(game, state, ours);
    assert.ok(!fs.existsSync(path.join(game, DLL)));
    plan.run();
    assert.ok(fs.readFileSync(path.join(game, DLL)).equals(ours));
    assert.equal(plan.state.chained, undefined);
    // (the DLL writes its ini and log on its first start: they go with it)
    fs.writeFileSync(path.join(game, INI), "[limits]\r\nenabled=1\r\n");
    fs.writeFileSync(path.join(game, LOG), "28 changes made\r\n");
    uninstall(game, state, plan.state);
    assert.deepEqual(fs.readdirSync(game), []);
});

test("a mod's dinput8.dll renamed and chained, and put back", () => {
    const { game, state } = folder();
    const mod = fakeDll(0x14c, false, "mod");
    fs.writeFileSync(path.join(game, DLL), mod);
    const plan = planInstall(game, state, fakeDll(0x14c, true));
    plan.run();
    assert.equal(plan.state.chained?.name, CHAINED);
    assert.ok(fs.readFileSync(path.join(game, CHAINED)).equals(mod));
    assert.equal(chainOf(fs.readFileSync(path.join(game, INI), "latin1")), CHAINED);
    assert.deepEqual(uninstallProblems(game, plan.state), []);
    uninstall(game, state, plan.state);
    assert.ok(fs.readFileSync(path.join(game, DLL)).equals(mod));
    assert.deepEqual(fs.readdirSync(game).sort(), [DLL]);
});

test("the player's own ini keeps its settings; its chain= given back", () => {
    const { game, state } = folder();
    fs.writeFileSync(path.join(game, DLL), fakeDll(0x14c, false, "mod"));
    const ini = "[limits]\r\nenabled=1\r\nnode_hash=0\r\n[loader]\r\nchain=old.dll\r\n";
    fs.writeFileSync(path.join(game, INI), ini);
    const plan = planInstall(game, state, fakeDll(0x14c, true));
    plan.run();
    assert.match(
        fs.readFileSync(path.join(game, INI), "latin1"),
        /node_hash=0\r\n\[loader\]\r\nchain=dinput8_chained\.dll/,
    );
    // (changed by the player since: only chain= goes back)
    fs.appendFileSync(path.join(game, INI), "; mine\r\n");
    uninstall(game, state, plan.state);
    const back = fs.readFileSync(path.join(game, INI), "latin1");
    assert.equal(chainOf(back), "old.dll");
    assert.match(back, /; mine/);
});

test("another build of the limits DLL kept and put back; the same one left alone", () => {
    const { game, state } = folder();
    const older = fakeDll(0x14c, true, "older");
    fs.writeFileSync(path.join(game, DLL), older);
    const plan = planInstall(game, state, fakeDll(0x14c, true, "newer"));
    plan.run();
    assert.ok(plan.state.replaced);
    uninstall(game, state, plan.state);
    assert.ok(fs.readFileSync(path.join(game, DLL)).equals(older));

    const same = planInstall(game, state, older);
    assert.equal(same.state.dll.installed, false);
    same.run();
    uninstall(game, state, same.state);
    assert.ok(fs.readFileSync(path.join(game, DLL)).equals(older));
});

test("ours changed since it was put there: left in place", () => {
    const { game, state } = folder();
    const plan = planInstall(game, state, fakeDll(0x14c, true));
    plan.run();
    fs.writeFileSync(path.join(game, DLL), fakeDll(0x14c, true, "replaced by hand"));
    const lines = uninstall(game, state, plan.state);
    assert.ok(fs.existsSync(path.join(game, DLL)));
    assert.match(lines.join("\n"), /left in place/);
});
