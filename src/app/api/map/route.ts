// API route — GET reads `src/game/map.json` and returns it.
// POST overwrites the file with the body. Dev-only convenience for the
// /map-editor route; in production this endpoint is a no-op (the file is
// read at build/runtime by zones.ts and never re-written).

import { NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAP_PATH = join(process.cwd(), "src", "game", "map.json");

interface MapPayload {
  cols: number;
  rows: number;
  tileSize: number;
  // Each cell is null OR { atlas, col, row, spanCols?, spanRows? }
  floor: (CellSlice | null)[][];
  decor: (CellSlice | null)[][];
}

interface CellSlice {
  atlas: string;
  col: number;
  row: number;
  spanCols?: number;
  spanRows?: number;
}

export async function GET() {
  try {
    const raw = await readFile(MAP_PATH, "utf8");
    return new NextResponse(raw, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No map saved yet — return an empty 32×22 stub.
      const empty: MapPayload = {
        cols: 32,
        rows: 22,
        tileSize: 16,
        floor: Array.from({ length: 22 }, () => Array(32).fill(null)),
        decor: Array.from({ length: 22 }, () => Array(32).fill(null)),
      };
      return NextResponse.json(empty);
    }
    return NextResponse.json(
      { error: String((err as Error).message ?? err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!isMapPayload(body)) {
    return NextResponse.json(
      { error: "body does not match MapPayload shape" },
      { status: 400 },
    );
  }
  try {
    await writeFile(MAP_PATH, JSON.stringify(body, null, 2), "utf8");
  } catch (err) {
    return NextResponse.json(
      { error: String((err as Error).message ?? err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, path: MAP_PATH });
}

function isMapPayload(v: unknown): v is MapPayload {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.cols === "number" &&
    typeof obj.rows === "number" &&
    typeof obj.tileSize === "number" &&
    Array.isArray(obj.floor) &&
    Array.isArray(obj.decor)
  );
}
