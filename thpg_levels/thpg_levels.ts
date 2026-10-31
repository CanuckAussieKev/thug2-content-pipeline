// NOT ORIGINAL - Tony Hawk's Proving Ground's levels (the Xbox 360 game's data) converted to THUG2's formats, for the
// level select's PROVING GROUND section (tools/pipeline/menu_level/make_menu_level.ts). Nothing of either game is in the
// repo: the files are made from the user's own copies each time. README.md has how to run it and what is converted.
//
// THPG is THP8's engine a year on: the same archives, scripts, node arrays, textures and scene container, so this is
// tools/pipeline/thp8_levels' converter run with THPG's profile (thp8_levels.useGame): its zones and levels, its scene
// reader (scene.ts: material block 0x0410, the uv fields re-packed), its light maps (one a zone, light.ts), its global
// stand-in textures, its collision (Havok 4.6's hkNxStorageExtendedMeshShape - thp8_levels/havok.ts).
//
// THPG's world is three cities streamed in zones that share one frame (metres, y up, as THP8's town): Philadelphia
// (z_love, z_fdr, z_bell, z_slums), Washington DC (z_monuments, z_museums, z_museum_int), Baltimore (z_bcity,
// z_lansdowne, z_harbor) and the bridges between them (z_pb_bridge, z_bw_bridge, z_wp_bridge), plus z_secret - qb.pak's
// Area_List. Its network levels (qb.pak's online_level_select_menu_level_info): WORLD (every zone), DC, BALTIMORE and
// PHILLY (an area closed off by its barriers: z_online_<x>) and the SKATE LOUNGE (z_crib with its default theme).

import * as path from "node:path";
import * as common from "../level_port/common.ts";
import { parseCli } from "../lib/cli.ts";
import { findCaseless, resolveInstall } from "../lib/install.ts";
import { isMain, print, pyExit, runMain } from "../lib/py.ts";
import * as thp8 from "../thp8_levels/thp8.ts";
import * as T from "../thp8_levels/thp8_levels.ts";
import * as xenos from "../thp8_levels/xenos.ts";
import * as layers from "./layers.ts";
import * as light from "./light.ts";
import "./scene.ts"; // (registers the 0x0410 scene reader with geom.ts)

export const STAGING = "thug2-decomp-thpg";
export const DEFAULT_ROOT = "C:\\Games\\Tony Hawk's Proving Grounds\\ProvingGround";

// THPG's areas (qb.pak's Area_List) and their zones. The city's zones are parts of the network levels, not levels by
// themselves (as THP8's); the bedroom is a level of its own (Level_Z_Bedroom, in no network level).
const city = (zone: string, sign: string, area: string): T.ZoneInfo => ({
    zone,
    sign,
    location: `THPG's ${area}`,
    levelNum: 0,
});
export const ZONES: readonly T.ZoneInfo[] = [
    city("z_love", "LOVE PARK", "Philadelphia: Love Park"),
    city("z_fdr", "FDR", "Philadelphia: FDR skatepark"),
    city("z_bell", "INDEPENDENCE HALL", "Philadelphia: the Liberty Bell"),
    city("z_slums", "NORTH PHILLY", "Philadelphia: North Philly"),
    city("z_monuments", "MONUMENTS", "Washington DC: the monuments"),
    city("z_museums", "DC MUSEUMS", "Washington DC: the museums"),
    city("z_museum_int", "AIR AND SPACE", "Washington DC: inside the air and space museum"),
    city("z_bcity", "BALTIMORE", "Baltimore: the city"),
    city("z_lansdowne", "LANSDOWNE", "Baltimore: Lansdowne"),
    city("z_harbor", "INNER HARBOR", "Baltimore: the inner harbor"),
    city("z_pb_bridge", "PHILLY-BALT BRIDGE", "bridge between Philadelphia and Baltimore"),
    city("z_bw_bridge", "BALT-DC BRIDGE", "bridge between Baltimore and Washington DC"),
    city("z_wp_bridge", "DC-PHILLY BRIDGE", "bridge between Washington DC and Philadelphia"),
    city("z_secret", "SECRET", "secret area"),
    {
        zone: "z_bedroom",
        sign: "BEDROOM",
        location: "THPG's bedroom",
        levelNum: 130,
        standalone: true,
    },
];

// The skate lounge (the network level SKATE LOUNGE: z_crib, area_pak Z_Crib - its own zone, no barriers) is drawn
// with one of its themes, the default one (z_crib_<Theme>: the room's floor, ramps and furniture).
export const CRIB_THEME = "z_crib_default";

export const NET_LEVEL_NUM = 131;

// THPG's network levels as THP8's specs: WORLD made of every zone of the cities (THPG's spawn_in names z_love alone -
// where its spawns are); the barrier levels as THP8's (spawn_in's zones, their area's main zone first - area_pak_zone
// names a load script there: load_z_slums -, the other zones' ground inside the barriers drawn as border zones); the
// skate lounge with its theme.
export function netSpecs(areas: readonly T.NetArea[]): T.LevelSpec[] {
    const cityZones = ZONES.filter((z) => !z.standalone).map((z) => z.zone);
    const out: T.LevelSpec[] = [];
    for (const a of areas.filter((x) => x.zones.length)) {
        const main = a.mainZone.replace(/^load_/, "");
        let zones = [...a.zones];
        let barriers = a.barriers ? [a.barriers] : [];
        if (a.id === "wholeworld") zones = [...a.zones, ...cityZones.filter((z) => !a.zones.includes(z))];
        else if (main && cityZones.includes(main) && !zones.includes(main)) zones = [main, ...zones];
        else if (main && zones.includes(main)) zones = [main, ...zones.filter((z) => z !== main)];
        if (barriers.some((b) => zones.includes(b))) barriers = []; // (the lounge's area_pak is the lounge itself)
        if (zones.includes("z_crib")) zones.push(CRIB_THEME);
        const id = a.id.replace(/^(online|net)/, "").toLowerCase();
        out.push({
            level: `thpg_net_${id}`,
            folder: `net_${id}`,
            zones,
            barriers,
            sign: a.text,
            location: `THPG's network level ${a.text}: ${zones.join(" + ")}`,
            levelNum: NET_LEVEL_NUM + out.length,
            ...(a.id === "wholeworld" ? { big: true } : {}),
        });
    }
    return out;
}

export function allSpecs(compressed: string, names: Map<number, string>): T.LevelSpec[] {
    const standalone = ZONES.filter((z) => z.standalone).map((z) => T.zoneSpec(z, new Map()));
    const net = netSpecs(T.networkAreas(compressed, names)).map((s) => ({
        ...s,
        sign: s.sign === "WORLD" ? "THE WORLD" : s.sign,
    }));
    return [...net, ...standalone];
}

// THPG's collision words: 0x800 is on nearly every face (108,892 of the city's ~300,000 triangles have only it - no
// THUG2 meaning: THUG2's 0x800 is "under ok"); left out.
export const FACE_DROP = 0x800;

layers.registerTemplates();

export const THPG_GAME: T.GameProfile = {
    key: "thpg",
    label: "THPG",
    install: "thpg",
    staging: STAGING,
    zones: ZONES,
    netLevelNum: NET_LEVEL_NUM,
    retired: [],
    sky: ["SKIES", "S_DEFAULT", "s_default.pak.xen"],
    specs: allSpecs,
    lighting: () => light.LIGHTING,
    prepareZone: (zone, file, warnings) => {
        if (!zone.geom) return;
        layers.decals(zone.geom, zone.textures);
        light.wireLightMaps(zone.geom, zone.textures);
        // (only a level's own zone: the _lod stand-ins are drawn only)
        const name = path
            .basename(file)
            .replace(/\.pak\.xen$/i, "")
            .toLowerCase();
        if (!zone.bodies.length && ZONES.some((z) => z.zone === name)) {
            zone.bodies = light.sceneCollision(zone.geom);
            if (zone.bodies.length)
                warnings.push(
                    `${file}: no collision - made from its drawn opaque triangles (${zone.bodies.length} bodies)`,
                );
        }
    },
    faceDrop: FACE_DROP,
};

// PAK\global_env_tex.pak.xen's textures (the stand-ins every zone's materials name: white, black, grey, the default
// cube and normal maps).
export function globalTextures(compressed: string): Map<number, xenos.XenosTexture> {
    const out = new Map<number, xenos.XenosTexture>();
    const file = findCaseless(compressed, "PAK", "global_env_tex.pak.xen");
    if (file === null) return out;
    const pak = thp8.openPak(file);
    for (const e of pak.entries) {
        if (e.extension !== ".tex") continue;
        for (const t of xenos.readXenosTex(thp8.entryData(pak, e), file)) out.set(t.checksum, t);
    }
    return out;
}

const USAGE = `usage: thpg_levels.ts {convert,selfcheck,list} [levels ...] [--thug2 THUG2] [--thpg THPG] [--out OUT]
                     [--ns NS] [--no-mips]

  convert     the levels (default all) into <thug2>\\${STAGING}
  selfcheck   read every zone archive's scene / textures / collision / qb files; round-trip THUG2's LA / TestLevel
  list        the levels and their zones

  --thug2     THUG2's folder (default C:\\Games\\THUG2) - the install root or its Game folder
  --thpg      Proving Ground's folder, holding DATA\\COMPRESSED (default ${DEFAULT_ROOT})
  --out       where convert writes (default <thug2>\\${STAGING})
  --ns        NeverScript's compiler (default out\\neverscript\\ns.exe)
  --no-mips   no mip levels (faster)
  --leave-out a regular expression: sectors whose names match are left out (scene and collision)`;

export function parseCommandLine(argv: readonly string[]): T.Args {
    const { values, positionals } = parseCli(USAGE, {
        args: [...argv],
        allowPositionals: true,
        options: {
            thug2: { type: "string" },
            thpg: { type: "string" },
            out: { type: "string" },
            ns: { type: "string" },
            "no-mips": { type: "boolean" },
            "leave-out": { type: "string" },
        },
    });
    const command = positionals[0];
    if (command !== "convert" && command !== "selfcheck" && command !== "list") {
        process.stderr.write(`${USAGE}\nerror: the command is convert, selfcheck or list\n`);
        pyExit(2);
    }
    return {
        command,
        levels: positionals.slice(1),
        thug2: values.thug2 ?? "C:\\Games\\THUG2",
        thp8: values.thpg ?? DEFAULT_ROOT,
        out: values.out ?? null,
        ns: values.ns ?? common.NS,
        noMips: values["no-mips"] ?? false,
        leaveOut: values["leave-out"] ? new RegExp(values["leave-out"], "i") : null,
    };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
    const args = parseCommandLine(argv);
    T.useGame(THPG_GAME);
    if (args.command === "list") return T.cmdList(args);
    args.thug2 = resolveInstall(args.thug2, "thug2");
    const compressed = T.compressedFolder(args.thp8);
    T.useGame({ ...THPG_GAME, textures: globalTextures(compressed) });
    if (args.command === "selfcheck") return T.cmdSelfcheck(args);
    const t0 = Date.now();
    const status = T.cmdConvert(args);
    print(`(${((Date.now() - t0) / 60000).toFixed(1)} minutes)`);
    return status;
}

if (isMain(import.meta.url)) await runMain(() => main());
