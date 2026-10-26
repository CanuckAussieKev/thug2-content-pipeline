// NOT ORIGINAL - the level select's globe as the game draws it: 22 sprites map0..map21 (64 x 64, Levelselect.prx),
// laid out by gamemenu_levelselect.qb's level_map_pieces as 8 columns of 4 stacked tiles (a 512 x 256 strip that
// wraps horizontally). Index 0 is the plain ocean tile every empty cell uses.

import * as path from "node:path";
import { entries } from "../../level_port/prx.ts";
import { decodeImg, picture } from "../ui.ts";

export const TILE = 64;
export const COLUMNS = 8;
export const ROWS = 4;
export const MAP_W = TILE * COLUMNS;
export const MAP_H = TILE * ROWS;
export const TILE_COUNT = 22;
// level_map_pieces: [column][row] -> map<n>
export const LAYOUT: readonly (readonly number[])[] = [
    [1, 0, 0, 0],
    [2, 3, 4, 0],
    [5, 6, 7, 8],
    [9, 10, 11, 0],
    [12, 13, 14, 0],
    [15, 16, 17, 0],
    [18, 19, 20, 21],
    [0, 0, 0, 0],
];

// The 22 tiles as 64 x 64 BGRA, by number.
export function originalTiles(game: string): Buffer[] {
    const tiles: Buffer[] = [];
    for (const [name, data] of entries(path.join(game, "Data", "pre", "Levelselect.prx"), (n) =>
        /map\d+\.img\.xbx$/i.test(n),
    )) {
        const n = Number(/map(\d+)\./i.exec(name)![1]);
        const img = decodeImg(data);
        if (img.iw !== TILE || img.ih !== TILE) throw new Error(`${name}: ${img.iw} x ${img.ih}`);
        tiles[n] = picture(img);
    }
    for (let i = 0; i < TILE_COUNT; i++) if (!tiles[i]) throw new Error(`map${i} missing`);
    return tiles;
}

// The strip (MAP_W x MAP_H BGRA at TILE = 64) assembled from tiles of `size` pixels.
export function assemble(tiles: readonly Buffer[], size = TILE): Buffer {
    const k = size / TILE;
    const w = MAP_W * k;
    const out = Buffer.alloc(w * MAP_H * k * 4);
    for (let c = 0; c < COLUMNS; c++)
        for (let r = 0; r < ROWS; r++) {
            const t = tiles[LAYOUT[c]![r]!]!;
            for (let y = 0; y < size; y++)
                t.copy(out, ((r * size + y) * w + c * size) * 4, y * size * 4, (y + 1) * size * 4);
        }
    return out;
}
