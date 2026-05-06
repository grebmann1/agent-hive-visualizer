// POST /api/map/agent — runs an Anthropic agent loop with tools that
// edit src/game/map.json. Streams progress as Server-Sent Events.
//
// Backend: Salesforce internal LLM gateway, which proxies to AWS Bedrock's
// Anthropic-on-Bedrock messages API. Body shape follows the Bedrock
// convention (no top-level `model`, includes `anthropic_version`). The
// SDK isn't used — we POST raw fetches because the SDK assumes
// api.anthropic.com's URL/body shape.
//
// Tools:
//   - getMap()                        : returns the current map's ASCII view + dims
//   - listTiles(category?)            : returns named TILE_* with descriptions
//   - placeTile(layer,col,row,tile)   : place a named tile
//   - fillRect(layer,colMin..,tile)   : fill a rectangle with a named tile
//   - eraseRect(layer,colMin..)       : clear a rectangle
//   - commit(reason)                  : declare done; persist map.json
//
// Caps: 50 tool-use steps, 60 sec wall clock, 200K input tokens.
//
// SSE events emitted to the client:
//   { type: "text", text }
//   { type: "tool_use", name, input }
//   { type: "tool_result", name, result }
//   { type: "map_updated", floor, decor }    // editor refetches on this
//   { type: "done", reason }
//   { type: "error", message }

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_TILES } from "../../../../game/limezu-tiles";
import type { AtlasSlice } from "../../../../game/atlas";
import manifest from "../../../../game/limezu-manifest.json";

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

const MAP_PATH = join(process.cwd(), "src", "game", "map.json");

// Default caps; overridable via env (see readAgentConfig).
const MAX_STEPS = 50;
const MAX_INPUT_TOKENS = 200_000;
const WALL_CLOCK_MS = 60_000;

interface MapPayload {
  cols: number;
  rows: number;
  tileSize: number;
  floor: (AtlasSlice | null)[][];
  decor: (AtlasSlice | null)[][];
}

// =============================================================================
// SSE plumbing
// =============================================================================

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Env vars:
//   LLM_GATEWAY_URL          — Salesforce internal gateway base (required)
//                              e.g. https://eng-ai-model-gateway…/chat/completions
//                              (we strip /chat/completions and append
//                               /bedrock/model/{id}/invoke per the Bedrock convention).
//   LLM_AUTH_TOKEN           — Bearer token for the gateway (required)
//   LLM_MODEL                — Bedrock model id (default: us.anthropic.claude-opus-4-7)
//   LLM_EXTRA_HEADERS        — optional JSON object of headers, merged into requests
//   AGENTQUEST_AGENT_MAX_STEPS / _MAX_INPUT_TOKENS / _WALL_CLOCK_MS — soft caps
function readAgentConfig() {
  const gatewayUrl = process.env.LLM_GATEWAY_URL;
  const authToken = process.env.LLM_AUTH_TOKEN;
  const model = process.env.LLM_MODEL || "us.anthropic.claude-opus-4-7";
  let extraHeaders: Record<string, string> = {};
  if (process.env.LLM_EXTRA_HEADERS) {
    try {
      const parsed = JSON.parse(process.env.LLM_EXTRA_HEADERS);
      if (parsed && typeof parsed === "object") extraHeaders = parsed;
    } catch {
      // ignore malformed
    }
  }
  return {
    gatewayUrl,
    authToken,
    model,
    extraHeaders,
    maxSteps: numEnv("AGENTQUEST_AGENT_MAX_STEPS", MAX_STEPS),
    maxInputTokens: numEnv("AGENTQUEST_AGENT_MAX_INPUT_TOKENS", MAX_INPUT_TOKENS),
    wallClockMs: numEnv("AGENTQUEST_AGENT_WALL_CLOCK_MS", WALL_CLOCK_MS),
  };
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function POST(req: Request) {
  const cfg = readAgentConfig();
  if (!cfg.gatewayUrl || !cfg.authToken) {
    return new Response(
      JSON.stringify({
        error:
          "LLM gateway is not configured. Set LLM_GATEWAY_URL and LLM_AUTH_TOKEN in .env.local and restart `npm run dev:web`.",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  let body: { prompt?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body — expected { prompt }" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const prompt = body.prompt?.trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(new TextEncoder().encode(sseEvent(obj)));
      };
      try {
        await runAgent(cfg, prompt, send);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

// =============================================================================
// Agent loop
// =============================================================================

// Anthropic Messages API content-block + message shapes — minimal subset
// we exchange with the Bedrock gateway. The gateway requires the same
// JSON the public Anthropic API uses, just at a different URL with no
// top-level `model` field and an `anthropic_version` field added.

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; required?: string[]; properties: Record<string, unknown> };
}

interface MessagesResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function runAgent(
  cfg: ReturnType<typeof readAgentConfig>,
  prompt: string,
  send: (obj: unknown) => void,
): Promise<void> {
  send({
    type: "text",
    text: `Agent starting · model=${cfg.model} · gateway=${cfg.gatewayUrl}`,
  });
  const startedAt = Date.now();

  // In-memory map; flushed to disk only when the agent calls `commit`.
  const map = await loadMap();

  const systemPrompt = buildSystemPrompt();
  const tools = TOOL_DEFS;

  const messages: MessageParam[] = [{ role: "user", content: prompt }];

  let inputTokens = 0;
  for (let step = 0; step < cfg.maxSteps; step++) {
    if (Date.now() - startedAt > cfg.wallClockMs) {
      send({ type: "error", message: `wall-clock cap hit (${cfg.wallClockMs}ms)` });
      return;
    }
    if (inputTokens > cfg.maxInputTokens) {
      send({ type: "error", message: `token cap hit (${cfg.maxInputTokens})` });
      return;
    }

    let resp: MessagesResponse;
    try {
      resp = await bedrockMessages(cfg, {
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ type: "error", message: msg });
      return;
    }
    inputTokens += resp.usage?.input_tokens ?? 0;

    // Stream text + tool_use blocks to the client.
    for (const block of resp.content) {
      if (block.type === "text") {
        send({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        send({ type: "tool_use", name: block.name, input: block.input });
      }
    }

    if (resp.stop_reason === "end_turn") {
      send({
        type: "done",
        reason: "agent ended turn without calling commit (changes NOT persisted)",
      });
      return;
    }

    if (resp.stop_reason !== "tool_use") {
      send({
        type: "error",
        message: `unexpected stop_reason: ${resp.stop_reason}`,
      });
      return;
    }

    // Append assistant turn (with tool_use blocks) to the message history.
    messages.push({ role: "assistant", content: resp.content });

    // Run each tool_use and append the tool_result.
    const toolResults: ToolResultBlock[] = [];
    let committed = false;
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      try {
        const result = runTool(map, block.name, block.input as Record<string, unknown>);
        send({ type: "tool_result", name: block.name, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
        if (block.name === "commit") {
          await writeMap(map);
          send({ type: "map_updated", floor: map.floor, decor: map.decor });
          send({ type: "done", reason: (result as { reason?: string }).reason ?? "commit" });
          committed = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "tool_result", name: block.name, result: { error: msg } });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: msg }),
          is_error: true,
        });
      }
    }
    if (committed) return;

    messages.push({ role: "user", content: toolResults });
  }

  send({ type: "error", message: `step cap hit (${cfg.maxSteps})` });
}

// =============================================================================
// Bedrock gateway HTTP — mirrors monaco-editor/packages/components'
// anthropicBedrock adapter shape. Strips `/chat/completions` from the
// gateway URL, appends `/bedrock/model/{id}/invoke`. Body uses the
// Anthropic Messages schema with `anthropic_version` added and `model`
// removed (the model is in the URL).
// =============================================================================

function buildBedrockUrl(gatewayUrl: string, model: string): string {
  const base = gatewayUrl.replace(/\/(?:v\d+\/)?chat\/completions\/?$/, "");
  return `${base}/bedrock/model/${model}/invoke`;
}

async function bedrockMessages(
  cfg: ReturnType<typeof readAgentConfig>,
  payload: {
    max_tokens: number;
    system: string;
    tools: ToolDef[];
    messages: MessageParam[];
  },
): Promise<MessagesResponse> {
  const url = buildBedrockUrl(cfg.gatewayUrl as string, cfg.model);
  const body = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    max_tokens: payload.max_tokens,
    system: payload.system,
    tools: payload.tools,
    messages: payload.messages,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.authToken}`,
    ...cfg.extraHeaders,
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM gateway ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as MessagesResponse;
}

// =============================================================================
// Tools
// =============================================================================

const TOOL_DEFS: ToolDef[] = [
  {
    name: "getMap",
    description:
      "Returns the current map dimensions and a compact ASCII view. Cells: '.' = empty/exterior grass, '#' = wall, 'D' = door, '~' = floor, 'o' = decor (furniture), '+' = floor+decor. Use this to understand the current state before placing tiles.",
    input_schema: {
      type: "object",
      properties: {},
    } as ToolDef["input_schema"],
  },
  {
    name: "listTiles",
    description:
      "Returns the named TILE_* catalog. Each tile has a name (use this in placeTile/fillRect), atlas key, col/row, and an optional spanCols/spanRows for multi-tile sprites. Optionally filter by category prefix: 'FLOOR_', 'WALL_', 'DOOR_', 'OFFICE_', 'BOOK', 'KITCHEN', 'LAB_', 'COUCH_', etc.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional name-prefix filter (e.g. 'FLOOR_', 'WALL_').",
        },
      },
    } as ToolDef["input_schema"],
  },
  {
    name: "placeTile",
    description:
      "Place a named tile on the floor or decor layer at (col, row). For multi-tile sprites, place the top-left only; the renderer expands the rest.",
    input_schema: {
      type: "object",
      required: ["layer", "col", "row", "tile"],
      properties: {
        layer: { type: "string", enum: ["floor", "decor"] },
        col: { type: "number" },
        row: { type: "number" },
        tile: { type: "string", description: "Named TILE_* from the catalog. Pass 'null' to erase." },
      },
    } as ToolDef["input_schema"],
  },
  {
    name: "fillRect",
    description:
      "Fill a rectangle (inclusive bounds) with a named tile on the chosen layer. Use this for floors and walls — way faster than placeTile per cell. Pass tile='null' to clear instead.",
    input_schema: {
      type: "object",
      required: ["layer", "colMin", "rowMin", "colMax", "rowMax", "tile"],
      properties: {
        layer: { type: "string", enum: ["floor", "decor"] },
        colMin: { type: "number" },
        rowMin: { type: "number" },
        colMax: { type: "number" },
        rowMax: { type: "number" },
        tile: { type: "string" },
      },
    } as ToolDef["input_schema"],
  },
  {
    name: "eraseRect",
    description:
      "Clear all cells in the rectangle on the chosen layer. Equivalent to fillRect with tile='null'.",
    input_schema: {
      type: "object",
      required: ["layer", "colMin", "rowMin", "colMax", "rowMax"],
      properties: {
        layer: { type: "string", enum: ["floor", "decor"] },
        colMin: { type: "number" },
        rowMin: { type: "number" },
        colMax: { type: "number" },
        rowMax: { type: "number" },
      },
    } as ToolDef["input_schema"],
  },
  {
    name: "commit",
    description:
      "Declare the map is done. Persists src/game/map.json. The agent loop ends after this call.",
    input_schema: {
      type: "object",
      required: ["reason"],
      properties: {
        reason: { type: "string", description: "1-sentence summary of what was built." },
      },
    } as ToolDef["input_schema"],
  },
];

interface ToolCtx {
  map: MapPayload;
}

function runTool(
  map: MapPayload,
  name: string,
  input: Record<string, unknown>,
): unknown {
  switch (name) {
    case "getMap":
      return {
        cols: map.cols,
        rows: map.rows,
        tileSize: map.tileSize,
        ascii: renderAscii(map),
      };
    case "listTiles":
      return listTilesTool(typeof input.category === "string" ? input.category : undefined);
    case "placeTile":
      return placeTileTool(map, input);
    case "fillRect":
      return fillRectTool(map, input);
    case "eraseRect":
      return fillRectTool(map, { ...input, tile: "null" });
    case "commit":
      return { ok: true, reason: input.reason ?? "" };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function listTilesTool(category?: string) {
  const out: Record<string, AtlasSlice & { description?: string }> = {};
  for (const [name, slice] of Object.entries(ALL_TILES)) {
    if (category && !name.toUpperCase().startsWith(category.toUpperCase())) continue;
    out[name] = slice;
  }
  return {
    count: Object.keys(out).length,
    tiles: out,
    note:
      "Each tile is a slice into a LimeZu atlas. For multi-tile sprites (spanCols/spanRows) place the top-left only.",
  };
}

function placeTileTool(map: MapPayload, input: Record<string, unknown>) {
  const layer = input.layer;
  const col = Number(input.col);
  const row = Number(input.row);
  const tileName = String(input.tile ?? "");
  if (layer !== "floor" && layer !== "decor") {
    throw new Error(`layer must be 'floor' or 'decor', got ${JSON.stringify(layer)}`);
  }
  if (!Number.isFinite(col) || !Number.isFinite(row)) {
    throw new Error(`col/row must be numbers; got col=${input.col} row=${input.row}`);
  }
  if (col < 0 || col >= map.cols || row < 0 || row >= map.rows) {
    throw new Error(
      `(${col}, ${row}) out of range; map is ${map.cols}x${map.rows}`,
    );
  }
  const slice = resolveTile(tileName);
  map[layer][row][col] = slice;
  return { ok: true, layer, col, row, tile: tileName };
}

function fillRectTool(map: MapPayload, input: Record<string, unknown>) {
  const layer = input.layer;
  if (layer !== "floor" && layer !== "decor") {
    throw new Error(`layer must be 'floor' or 'decor'`);
  }
  const colMin = Math.max(0, Number(input.colMin));
  const colMax = Math.min(map.cols - 1, Number(input.colMax));
  const rowMin = Math.max(0, Number(input.rowMin));
  const rowMax = Math.min(map.rows - 1, Number(input.rowMax));
  if (
    !Number.isFinite(colMin) ||
    !Number.isFinite(colMax) ||
    !Number.isFinite(rowMin) ||
    !Number.isFinite(rowMax) ||
    colMax < colMin ||
    rowMax < rowMin
  ) {
    throw new Error(
      `bad rect: colMin=${input.colMin} rowMin=${input.rowMin} colMax=${input.colMax} rowMax=${input.rowMax}`,
    );
  }
  const tileName = String(input.tile ?? "");
  const slice = resolveTile(tileName);
  let painted = 0;
  for (let r = rowMin; r <= rowMax; r++) {
    for (let c = colMin; c <= colMax; c++) {
      map[layer][r][c] = slice;
      painted++;
    }
  }
  return { ok: true, layer, painted, tile: tileName };
}

function resolveTile(name: string): AtlasSlice | null {
  if (!name || name.toLowerCase() === "null") return null;
  const slice = (ALL_TILES as Record<string, AtlasSlice>)[name];
  if (!slice) {
    const known = Object.keys(ALL_TILES);
    const close = known
      .filter((k) => k.toUpperCase().includes(name.toUpperCase().slice(0, 3)))
      .slice(0, 5);
    throw new Error(
      `unknown tile name '${name}'. ${close.length ? `Did you mean: ${close.join(", ")}?` : `Use listTiles() to see available names.`}`,
    );
  }
  return slice;
}

// =============================================================================
// Map I/O + ASCII renderer
// =============================================================================

async function loadMap(): Promise<MapPayload> {
  const raw = await readFile(MAP_PATH, "utf8");
  const parsed = JSON.parse(raw) as MapPayload;
  // Normalize to canonical 32×22 with null-filled rows.
  const cols = parsed.cols || 32;
  const rows = parsed.rows || 22;
  const grow = (
    layer: (AtlasSlice | null)[][] | undefined,
  ): (AtlasSlice | null)[][] => {
    const out: (AtlasSlice | null)[][] = [];
    for (let r = 0; r < rows; r++) {
      const src = (layer && layer[r]) || [];
      const newRow: (AtlasSlice | null)[] = new Array(cols).fill(null);
      for (let c = 0; c < cols; c++) {
        const cell = src[c];
        if (cell) newRow[c] = cell;
      }
      out.push(newRow);
    }
    return out;
  };
  return {
    cols,
    rows,
    tileSize: parsed.tileSize || manifest.tileSize,
    floor: grow(parsed.floor),
    decor: grow(parsed.decor),
  };
}

async function writeMap(map: MapPayload) {
  await writeFile(MAP_PATH, JSON.stringify(map, null, 2), "utf8");
}

function renderAscii(map: MapPayload): string {
  // Build a row of column-indices header, then `rrr | row-data` for each row.
  // Glyphs:
  //   '.'  null  (exterior grass)
  //   '#'  wall  (any FLOOR slice in the wall set)
  //   'D'  door
  //   '~'  floor (any other FLOOR slice)
  //   'o'  decor only (no floor)
  //   '+'  floor + decor
  const wallShapes = new Set<string>();
  const doorShapes = new Set<string>();
  for (const [name, s] of Object.entries(ALL_TILES)) {
    if (name.startsWith("WALL_")) wallShapes.add(sliceKey(s));
    if (name.startsWith("DOOR_")) doorShapes.add(sliceKey(s));
  }
  const lines: string[] = [];
  // Header — cols 0..N as a single line of single-digit indices (modulo).
  const hdr =
    "    " +
    Array.from({ length: map.cols }, (_, c) => (c % 10).toString()).join("");
  lines.push(hdr);
  for (let r = 0; r < map.rows; r++) {
    let line = `${String(r).padStart(3, " ")} `;
    for (let c = 0; c < map.cols; c++) {
      const f = map.floor[r][c];
      const d = map.decor[r][c];
      let ch = ".";
      if (f) {
        const k = sliceKey(f);
        if (wallShapes.has(k)) ch = "#";
        else if (doorShapes.has(k)) ch = "D";
        else ch = "~";
      }
      if (d) {
        ch = ch === "~" ? "+" : ch === "." ? "o" : ch;
      }
      line += ch;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function sliceKey(s: AtlasSlice): string {
  return `${s.atlas}:${s.col}:${s.row}`;
}

// =============================================================================
// System prompt
// =============================================================================

function buildSystemPrompt(): string {
  // Inline a brief tile vocabulary so Claude knows what's available without
  // a listTiles round-trip on every run. Actual coords are looked up
  // server-side via name.
  const tileNames = Object.keys(ALL_TILES).sort();
  return `You are a level designer building a 32×22 top-down pixel-art map for an
"office observatory" app. The map has two layers (floor + decor) and uses
LimeZu Modern Office + Modern Interiors tiles.

PROCESS:
1. Call getMap() first to see what's already on the canvas (ASCII view).
2. Plan: decide rooms, walls, doors, furniture.
3. Use fillRect for big areas (floors, walls). Use placeTile for individual
   pieces of furniture. Multi-tile sprites (e.g. FRIDGE with spanRows=2,
   ROUND_TABLE with spanCols=2 spanRows=2) only need their top-left placed.
4. After substantial changes, call getMap() again to verify what you painted.
5. When satisfied, call commit(reason). The map is NOT saved until commit().

CONSTRAINTS:
- Map is 32 wide × 22 tall, indexed (col, row) starting at (0, 0).
- Cells off the map are silently ignored.
- Doors must be walkable — use a DOOR_* tile in the wall row, not a wall.
- Walls go on the FLOOR layer (they are floor-replacements that block movement).
- Decor goes on the DECOR layer (furniture, plants, monitors).
- Empty cells stay null — they render as exterior grass.

AVAILABLE NAMED TILES (use exact names; case-sensitive):
${tileNames.join(", ")}

Use listTiles("FLOOR_") etc. to see each tile's atlas/coords if useful.

Be DECISIVE — favor fillRect over many placeTile calls. Aim to complete
in <15 tool calls. Don't get stuck inspecting; plan once, paint, commit.`;
}
