// NOT ORIGINAL - THAW's BMX for THUG2: the levels' own parked bikes (the engine side and what THAW does:
// src/game/skater/thaw_bmx_parked.h; the scripts: ride.ts parkedScripts).
//
// THAW lists its levels' bikes in bike_ped_ids (bike_scripts.qb: {level=Z_HO id=Z_HO_TRG_Ped_BikeGuy} ...) - each a
// pedestrian node whose body is the bike. Read from the user's THAW at convert time: each node's Pos and Angles in the
// THAW level as THUG2 has it after tools/pipeline/thaw_levels (its THUG2 name, levelName, and its default frame, frameShift - the
// shift thaw_levels moves every node by), written as
//
//   thaw_bmx_home_bikes = [{level=z_ho pos=(x, y, z) heading=<degrees>} ...]
//
// (heading: the node's Angles y in degrees - the same rotation, 0 = +z, as Obj_SetOrientation y= makes). The DLL's
// ThawBmx_HomeSpot reads it by the current level structure's `level`. Nothing of THAW is stored.

import { FormatError } from "../level_port/binio.ts";
import type { QbValue } from "../level_port/qb.ts";
import * as qb from "../level_port/qb.ts";
import { Name, Struct, Vector } from "../level_port/qb.ts";
import * as levels from "../thaw_levels/thaw_levels.ts";

export const HOME_BIKES = "thaw_bmx_home_bikes";

export interface HomeBike {
    zone: string; // THAW's zone (Z_HO)
    level: string; // the THUG2 level's name (z_ho, vans ...)
    node: string; // THAW's node
    pos: [number, number, number];
    heading: number; // degrees
}

// THAW's bike_ped_ids entries: [zone, node name].
export function bikePedIds(value: QbValue | undefined, names: ReadonlyMap<number, string>): [string, string][] {
    if (!Array.isArray(value)) throw new FormatError("THAW's bike_ped_ids isn't an array");
    return value.map((entry) => {
        const level = entry instanceof Struct ? entry.get("level") : undefined;
        const id = entry instanceof Struct ? entry.get("id") : undefined;
        if (!(level instanceof Name) || !(id instanceof Name)) throw new FormatError("THAW's bike_ped_ids: {level id}");
        return [qb.nameText(level.value, names), qb.nameText(id.value, names)];
    });
}

// A node's place as THUG2's port of the level has it: its Pos moved by the level's shift, its Angles y in degrees.
export function placeOf(node: Struct, shift: readonly number[]): { pos: [number, number, number]; heading: number } {
    const pos = node.get("Pos");
    if (!(pos instanceof Vector) || pos.kind !== "vector") throw new FormatError("a bike node without a Pos");
    const angles = node.get("Angles");
    const y = angles instanceof Vector && angles.kind === "vector" ? angles.values[1]! : 0.0;
    const p = [0, 1, 2].map((k) => pos.values[k]! + (shift[k] ?? 0.0));
    return { pos: [p[0]!, p[1]!, p[2]!], heading: (y * 180.0) / Math.PI };
}

// Each level's bike read from THAW's zones (a zone the install hasn't, or a node it hasn't: left out, in `report`).
export function homeBikes(
    thawFolder: string,
    ids: readonly [string, string][],
    names: Map<number, string>,
    report: string[],
): HomeBike[] {
    const bikes: HomeBike[] = [];
    for (const [zone, node] of ids) {
        const pak = levels.zonePak(thawFolder, zone);
        if (pak === null) {
            report.push(`parked bikes: ${zone}: no ${zone.toLowerCase()}_net.pak.wpc - left out`);
            continue;
        }
        const array = levels.zoneArray(levels.zoneFiles(pak), zone, names);
        const want = qb.checksum(node);
        const found = array.find(
            (n) => n instanceof Struct && n.get("Name") instanceof Name && (n.get("Name") as Name).value === want,
        );
        if (!(found instanceof Struct)) {
            report.push(`parked bikes: ${zone}: no node ${node} - left out`);
            continue;
        }
        bikes.push({
            zone,
            level: levels.levelName(zone),
            node,
            ...placeOf(found, levels.frameShift(zone, array, names)),
        });
    }
    return bikes;
}

const f = (x: number): string => {
    const s = x.toFixed(3);
    return s === "-0.000" ? "0.000" : s;
};

// The NeverScript global.
export function homeBikesText(bikes: readonly HomeBike[]): string {
    if (!bikes.length) return "// (no levels' own bikes: none of THAW's bike_ped_ids found)\n";
    const rows = bikes.map(
        (b) => `    {level=${b.level} pos=(${f(b.pos[0])}, ${f(b.pos[1])}, ${f(b.pos[2])}) heading=${f(b.heading)}}`,
    );
    return `// (THAW's bike_ped_ids: ${bikes.map((b) => b.node).join(", ")})\n${HOME_BIKES} = [\n${rows.join("\n")}\n]\n`;
}
