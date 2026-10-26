// NOT ORIGINAL - takes the scenic art's candidate pictures in the game (scenic_spots.ts picks the poses): the converted
// level started in free skate (run_game.ps1 -Level), the HUD hidden (the game's own script hide_panel_stuff), and for
// each candidate the skater put on the ground under the camera (out of the picture), viewport 0's camera held at the
// pose (the automation channel's `camera` - src/game/front/test_view.h), a moment to settle and one frame captured
// (`capture 1`: the frame as drawn, at the window's size - the workspace's ini set to 2560 x 1440).
//
// The pictures are renders of the user's own converted level (the game's textures): they are NOT committed (nothing
// of the games is) but kept in a cache outside the repo, %LOCALAPPDATA%\thug2-decomp\scenic-art\<game>\<level>\
// cand_<id>.png (with the capture's sidecar series.txt), where scenic_art.ts and make_menu_level.ts read them. What
// makes them reproducible is committed: the poses (scenic_art/<game>.json) and this tool.
//
// Workspaces only, under the game lock (tools/pipeline/game/game_lock.ps1 -Action acquire ... first; the automation channel on):
//   node tools/pipeline/menu_level/scenic_capture.ts --game C:\Games\THUG2-4 [--spots tools/pipeline/menu_level/scenic_art/thps3.json]
//       [--settle 45] [level...]
// (the ini's [Graphics] ResolutionX / ResolutionY decide the pictures' size - 2560 x 1440 for the HD art.)

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCli } from "../lib/cli.ts";
import { PIPELINE } from "../lib/decomp.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { type Candidate, cameraCommands, readSpots } from "./scenic_spots.ts";

// The cache of captured pictures (outside the repo).
export function cacheDir(game: string): string {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "thug2-decomp", "scenic-art", game);
}
export const capturePath = (game: string, level: string, id: number): string =>
    path.join(cacheDir(game), level, `cand_${id}.png`);
export const seriesFolder = (level: string, id: number): string => `scenic_${level}_${id}`;

// The automation commands for one level's candidates: wait for the level, hide the HUD, then each pose and a frame.
export function levelCommands(level: string, list: readonly Candidate[], settle = 45, start = level): string[] {
    const out = [`waitfor level ${start} 300`, "wait 120", "run hide_panel_stuff"];
    for (const c of list) {
        out.push(...cameraCommands(c), `wait ${settle}`, `capture 1 ${seriesFolder(level, c.id)}`);
    }
    out.push("camera off");
    return out;
}

const USAGE = "usage: scenic_capture.ts --game <workspace> [--spots <json>] [--settle N] [level...]";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: {
            game: { type: "string" },
            spots: {
                type: "string",
                default: path.join(PIPELINE, "menu_level", "scenic_art", "thps3.json"),
            },
            settle: { type: "string", default: "45" },
        },
        allowPositionals: true,
    });
    const game = values.game;
    if (!game) {
        print(USAGE);
        return 2;
    }
    if (/^c:\\games\\thug2\\?$/i.test(game) || /\\THUG2\\Game\\?$/i.test(game))
        throw new Error("the main install is for the user's own testing: use a workspace (C:\\Games\\THUG2-n)");
    const spots = readSpots(values.spots);
    const levels = positionals.length ? positionals : Object.keys(spots.levels);
    const shots = path.join(game, "Screenshots");
    let failed = 0;
    for (const level of levels) {
        const entry = spots.levels[level];
        if (!entry) throw new Error(`${level}: not in ${values.spots}`);
        const start = entry.start ?? level;
        const commands = levelCommands(level, entry.candidates, Number(values.settle), start);
        for (const c of entry.candidates)
            fs.rmSync(path.join(shots, seriesFolder(level, c.id)), { recursive: true, force: true });
        const result = spawnSync(
            "powershell",
            [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                path.join(PIPELINE, "game", "run_game.ps1"),
                "-Game",
                game,
                "-Level",
                start,
                "-Seconds",
                "400",
                "-Shot",
                `scenic_${level}`,
                "-Commands",
                commands.join(";"),
            ],
            { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
        let got = 0;
        for (const c of entry.candidates) {
            const frame = path.join(shots, seriesFolder(level, c.id), "frame_0001.png");
            if (!fs.existsSync(frame)) continue;
            const to = capturePath(spots.game, level, c.id);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(frame, to);
            const sidecar = path.join(shots, seriesFolder(level, c.id), "series.txt");
            if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, to.replace(/\.png$/, ".txt"));
            got += 1;
        }
        print(`${level}: ${got} of ${entry.candidates.length} pictures (run_game exit ${result.status})`);
        if (got < entry.candidates.length) {
            failed += 1;
            print((result.stdout ?? "").split(/\r?\n/).slice(-15).join("\n"));
        }
    }
    print(`pictures in ${cacheDir(spots.game)}`);
    return failed ? 1 : 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
