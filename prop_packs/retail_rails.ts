// NOT ORIGINAL - the level editor's rails on a retail THUG2 install (retail/retail_export.ts): the rail points the
// editor added in one of THUG2's own levels - the placed prop packs' rails, prefabs' rails, rails drawn in the editor
// (the layout's `point <name> RailNode ...` records, src/editor/level_editor_chains.h) - appended to the level's node
// array as the game's own RailNode nodes, so the original game grinds them:
//
//   Data\pre\<L>_scripts.prx  levels\<L>\<L>.qb   the node array the game loads (its start-up loads the levels' archives)
//   Data\levels\<L>\<L>.qb                        the loose copy (read when the archives aren't: kept the same)
//
// Only appended - the level's own nodes keep their indexes (the links between nodes are indexes), every other byte of
// the file and of the archive stays as it was. The export keeps each file's bytes from before (its state folder) and the
// names it appended: uninstall gives the bytes back when nothing else changed the file since, else takes its nodes off
// the end again (the user's other changes stay); our nodes not at the end any more: refused.
// Links to the level's own nodes (a rail joined onto one of the level's) can't be carried (the level node's own links
// would have to change): dropped, reported. Rail points of trick objects (cluster=) go in as plain rails.

import { checksum, Name, QbFile, type QbValue, Struct, Vector } from "thug2-level-converter-core/level_port/qb.ts";
import { replaceGlobalArray } from "thug2-level-converter-core/level_port/qb_write.ts";

export interface RailPoint {
    name: string;
    pos: { x: number; y: number; z: number };
    terrain: string; // TERRAIN_... ("" none: TERRAIN_GRINDMETAL, as the editor bakes it)
    links: number[]; // the names' checksums
    cluster: number; // (trick object: not carried)
}

const DEFAULT_TERRAIN = "TERRAIN_GRINDMETAL";

function hexWord(word: string): number | null {
    return /^[0-9a-f]{8}$/i.test(word) ? Number.parseInt(word, 16) >>> 0 : null;
}

// The layout's added rail points (src/editor/level_editor_chains_records.cpp write_records: `point <name> RailNode
// pos=x,y,z [like=] [terrain=] [links=a,b] [cluster=] ...` - links as 8 hex digits).
export function readLayoutRails(text: string): RailPoint[] {
    const out: RailPoint[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.split("#")[0]!.trim();
        const w = line.split(/\s+/);
        if (w[0] !== "point" || w[2] !== "RailNode" || !w[1]) continue;
        const point: RailPoint = { name: w[1], pos: { x: 0, y: 0, z: 0 }, terrain: "", links: [], cluster: 0 };
        let havePos = false;
        for (const word of w.slice(3)) {
            const eq = word.indexOf("=");
            if (eq < 0) continue;
            const key = word.slice(0, eq);
            const value = word.slice(eq + 1);
            if (key === "pos") {
                const v = value.split(",").map(Number);
                if (v.length === 3 && v.every(Number.isFinite)) {
                    point.pos = { x: v[0]!, y: v[1]!, z: v[2]! };
                    havePos = true;
                }
            } else if (key === "terrain") point.terrain = value;
            else if (key === "links")
                point.links = value
                    .split(",")
                    .map(hexWord)
                    .filter((x): x is number => x !== null);
            else if (key === "cluster") point.cluster = hexWord(value) ?? 0;
        }
        if (havePos) out.push(point);
    }
    return out;
}

// The node array's name in a level's .qb: <level>_NodeArray, else its biggest top-level array of structures.
export function nodeArrayName(file: QbFile, level: string): number {
    const wanted = checksum(`${level}_NodeArray`);
    if (file.globals.some(([k, v]) => k.value === wanted && Array.isArray(v))) return wanted;
    let best: [number, number] = [0, -1];
    for (const [k, v] of file.globals) {
        if (Array.isArray(v) && v.length > best[1] && v.every((x) => x instanceof Struct)) best = [k.value, v.length];
    }
    return best[0];
}

function nodeArray(data: Buffer, level: string): { name: number; nodes: Struct[]; file: QbFile } {
    const file = new QbFile(data, `${level}.qb`, true);
    const name = nodeArrayName(file, level);
    const value = file.globals.find(([k]) => k.value === name)?.[1];
    if (!name || !Array.isArray(value)) throw new Error(`${level}.qb: no node array`);
    return { name, nodes: value as Struct[], file };
}

function nodeName(node: Struct): number {
    const v = node.get("Name");
    return v instanceof Name ? v.value : 0;
}

export interface Appended {
    data: Buffer;
    arrayName: number;
    baseCount: number;
    nodes: string[]; // the names appended, in order
    droppedLinks: number; // links to nodes that aren't added points (the level's own): not carried
    clashes: string[]; // points whose name the level has already: left out
}

// `points` appended to the level's node array in `data` (a level's .qb).
export function appendRails(data: Buffer, level: string, points: readonly RailPoint[]): Appended {
    const array = nodeArray(data, level);
    const taken = new Set(array.nodes.map(nodeName));
    const clashes = points.filter((p) => taken.has(checksum(p.name))).map((p) => p.name);
    const kept = points.filter((p) => !taken.has(checksum(p.name)));
    const index = new Map(kept.map((p, k) => [checksum(p.name), array.nodes.length + k]));
    const names = new Map<number, string>();
    const remember = (text: string): number => {
        const c = checksum(text);
        names.set(c, text);
        return c;
    };
    let droppedLinks = 0;
    const values: QbValue[] = [];
    for (const p of kept) {
        const links: number[] = [];
        for (const l of p.links) {
            const at = index.get(l);
            if (at === undefined) droppedLinks++;
            else links.push(at);
        }
        const s = new Struct();
        s.entries.push([new Name(remember("Pos")), new Vector("vector", [p.pos.x, p.pos.y, p.pos.z])]);
        s.entries.push([new Name(remember("Angles")), new Vector("vector", [0, 0, 0])]);
        s.entries.push([new Name(remember("Name")), new Name(remember(p.name))]);
        s.entries.push([new Name(remember("Class")), new Name(remember("RailNode"))]);
        s.entries.push([null, new Name(remember("CreatedAtStart"))]);
        s.entries.push([new Name(remember("TerrainType")), new Name(remember(p.terrain || DEFAULT_TERRAIN))]);
        if (links.length) s.entries.push([new Name(remember("Links")), links]);
        values.push(s);
    }
    const elements = [...array.nodes.map((_, keep) => ({ keep })), ...values.map((value) => ({ value }))];
    return {
        data: kept.length ? replaceGlobalArray(data, array.name, elements, names, true) : data,
        arrayName: array.name,
        baseCount: array.nodes.length,
        nodes: kept.map((p) => p.name),
        droppedLinks,
        clashes,
    };
}

// `data` without the nodes `names` appended at the end of the level's node array (null: they aren't its last nodes -
// something else changed the array since). The names they added to the file's name table stay (harmless).
export function stripRails(data: Buffer, level: string, names: readonly string[]): Buffer | null {
    const array = nodeArray(data, level);
    const n = array.nodes.length;
    if (n < names.length) return null;
    const tail = array.nodes.slice(n - names.length).map(nodeName);
    if (tail.some((c, k) => c !== checksum(names[k]!))) return null;
    if (!names.length) return data;
    const elements = array.nodes.slice(0, n - names.length).map((_, keep) => ({ keep }));
    return replaceGlobalArray(data, array.name, elements, new Map(), true);
}
