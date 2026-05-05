import { MAP_COLS, MAP_ROWS, isWalkable } from "./rooms";

export interface Cell {
  col: number;
  row: number;
}

function key(col: number, row: number): number {
  return row * MAP_COLS + col;
}

export interface BfsOptions {
  /** Extra cells to treat as blocked (e.g., player, other NPCs). */
  blocked?: Iterable<{ col: number; row: number }>;
}

/**
 * Breadth-first path from (sc,sr) to (tc,tr). Returns a list of cells
 * INCLUDING the start and the target. Returns empty array if no path.
 */
export function bfs(
  sc: number,
  sr: number,
  tc: number,
  tr: number,
  opts: BfsOptions = {},
): Cell[] {
  const blockedSet = new Set<number>();
  if (opts.blocked) {
    for (const b of opts.blocked) blockedSet.add(key(b.col, b.row));
  }
  // If target cell is blocked (e.g., player standing on anchor), bail.
  if (!isWalkable(tc, tr) || blockedSet.has(key(tc, tr))) return [];
  if (sc === tc && sr === tr) return [{ col: sc, row: sr }];

  const prev = new Map<number, number>();
  const queue: Cell[] = [{ col: sc, row: sr }];
  const seen = new Set<number>([key(sc, sr)]);

  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  let found = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.col === tc && cur.row === tr) {
      found = true;
      break;
    }
    for (const [dc, dr] of dirs) {
      const nc = cur.col + dc;
      const nr = cur.row + dr;
      if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
      const k = key(nc, nr);
      if (seen.has(k)) continue;
      if (!isWalkable(nc, nr)) continue;
      if (blockedSet.has(k)) continue;
      seen.add(k);
      prev.set(k, key(cur.col, cur.row));
      queue.push({ col: nc, row: nr });
    }
  }

  if (!found) return [];

  const path: Cell[] = [];
  let ck = key(tc, tr);
  const startK = key(sc, sr);
  while (ck !== startK) {
    const col = ck % MAP_COLS;
    const row = Math.floor(ck / MAP_COLS);
    path.push({ col, row });
    const p = prev.get(ck);
    if (p === undefined) return [];
    ck = p;
  }
  path.push({ col: sc, row: sr });
  return path.reverse();
}
