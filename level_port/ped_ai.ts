// NOT ORIGINAL - the animations THUG2's ped AI may play (moved from thug1_levels/thug1_peds.ts with the converters'
// split: the THPS3 converter's people use it too).

import * as prx from "./prx.ts";
import * as qb from "./qb.ts";
import { Name, Struct } from "./qb.ts";

// THUG2's global values (every qb of qb_scripts.prx), to follow the names a script passes on to the animations they
// list (standing_anims=Skater2_goal_wait, generic_ped_anims_wait, default_M_anim_assets -> default_m_walk_anims...).
export class Thug2Globals {
    readonly values = new Map<number, qb.QbValue>();
    readonly pedScriptNames = new Set<number>(); // every name the ped AI's scripts use (pedAiAnims)
    readonly skaterScriptNames = new Set<number>(); // those of its skating peds' (Sk5_PedSkater.qb)

    constructor(qbScripts: string) {
        // (the ped AI: game\ped\*.qb, sk4_Ped*.qb, ped.qb - not the unique states' SK6Ped_UniqueStateLogic, whose peds
        // THUG2's levels make, nor SK6Ped_Data's lists other than through the names the scripts use)
        const isPed = (n: string): boolean => /ped/i.test(n) && !/cas_ped|profile_ped|uniquestate|sk6ped_data/i.test(n);
        for (const [n, data] of prx.entries(qbScripts, (name) => name.toLowerCase().endsWith(".qb"))) {
            try {
                for (const [k, v] of new qb.QbFile(data, n, true).globals) this.values.set(k.value, v);
            } catch (e) {
                if (!(e instanceof RangeError || e instanceof Error)) throw e;
            }
            if (!isPed(n)) continue;
            const to = /sk5_pedskater/i.test(n) ? this.skaterScriptNames : this.pedScriptNames;
            for (const [, t, p] of qb.tokens(data, true)) if (t === 0x16) to.add(p.readUInt32LE(0));
        }
    }

    // The animations (isAnim) `names` reach: themselves, or through the globals they name, `depth` deep.
    reach(
        names: Iterable<number>,
        isAnim: (name: number) => boolean,
        depth = 2,
        more?: ReadonlyMap<number, qb.QbValue>,
    ): Set<number> {
        const out = new Set<number>();
        const seen = new Set<number>();
        const visit = (name: number, left: number): void => {
            if (isAnim(name)) out.add(name);
            if (left <= 0 || seen.has(name)) return;
            seen.add(name);
            const value = this.values.get(name) ?? more?.get(name);
            if (value !== undefined) walk(value, left - 1);
        };
        const walk = (v: qb.QbValue, left: number): void => {
            if (v instanceof Name) visit(v.value, left);
            else if (Array.isArray(v)) for (const x of v) walk(x, left);
            else if (v instanceof Struct) for (const [, x] of v.entries) walk(x, left);
        };
        for (const n of names) visit(n, depth);
        return out;
    }
}

// The animations THUG2's ped AI may play: those its scripts name, directly or through the globals they name - the
// walkers' and stand-ers', and the skating peds' besides (their tricks: Sk5_PedSkater's trick lists).
export function pedAiAnims(
    globals: Thug2Globals,
    known: ReadonlySet<number>,
): { walker: Set<number>; skater: Set<number> } {
    const walker = globals.reach(globals.pedScriptNames, (n) => known.has(n), 3);
    const skater = globals.reach(globals.skaterScriptNames, (n) => known.has(n) && !walker.has(n), 3);
    return { walker, skater };
}
