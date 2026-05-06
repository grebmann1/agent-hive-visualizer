"use client";

// /map-editor — author the building's tile layout by clicking.
//
// Three areas:
//   - Toolbar (top)   : layer toggle, eraser, save, status, brush size, zoom.
//   - Tile palette    : two tabs.
//       * NAMED   = every TILE_* from limezu-tiles.ts grouped by category.
//       * RAW     = browse any atlas at chunky scale, click a cell to pick it.
//   - Grid (right)    : 32×22 cells, click to place the active tile on the
//                       active layer, or erase if the eraser is active.
//
// Persistence: GET /api/map → load. POST /api/map → save src/game/map.json.
// The game's zones.ts reads that file at build time so what you author here
// IS what the world looks like.
//
// Multi-tile sprites: when the active tile has spanCols/spanRows >1, click
// places it as the top-left and the renderer expands automatically.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import manifest from "../../game/limezu-manifest.json";
import { ALL_TILES } from "../../game/limezu-tiles";
import type { AtlasSlice } from "../../game/atlas";

type Layer = "floor" | "decor";
type PaletteMode = "named" | "raw";

interface MapPayload {
  cols: number;
  rows: number;
  tileSize: number;
  floor: (AtlasSlice | null)[][];
  decor: (AtlasSlice | null)[][];
}

const ATLAS_BY_KEY = new Map<string, (typeof manifest.atlases)[number]>();
for (const a of manifest.atlases) ATLAS_BY_KEY.set(a.key, a);

const TILE_PUBLIC_PREFIX = manifest.publicPathPrefix;
const TILE_PX = manifest.tileSize;

// =============================================================================
// Page
// =============================================================================

export default function MapEditorPage() {
  // Map state — load from API on mount.
  const [map, setMap] = useState<MapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<string>("");

  // Editor state.
  const [activeLayer, setActiveLayer] = useState<Layer>("floor");
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("named");
  const [activeTile, setActiveTile] = useState<AtlasSlice | null>(null);
  const [erasing, setErasing] = useState(false);
  const [zoom, setZoom] = useState(2);
  // Hover preview for the grid.
  const [hoverCell, setHoverCell] = useState<{ col: number; row: number } | null>(null);
  // Track if mouse is held for drag-paint.
  const isPaintingRef = useRef(false);

  useEffect(() => {
    let aborted = false;
    fetch("/api/map")
      .then((r) => r.json())
      .then((raw: MapPayload) => {
        if (aborted) return;
        // Normalize: any stub map (empty arrays, wrong dims) gets resized
        // to a clean COLS×ROWS grid of nulls so the editor renders.
        setMap(normalizeMap(raw));
        setLoading(false);
      })
      .catch((err) => {
        if (aborted) return;
        setSaveStatus(`load failed: ${String(err)}`);
        setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, []);

  const placeAt = useCallback(
    (col: number, row: number) => {
      setMap((prev) => {
        if (!prev) return prev;
        if (col < 0 || col >= prev.cols || row < 0 || row >= prev.rows) return prev;
        const layerKey = activeLayer;
        const next: MapPayload = {
          ...prev,
          floor: prev.floor.map((r) => r.slice()),
          decor: prev.decor.map((r) => r.slice()),
        };
        const target = next[layerKey];
        if (erasing || !activeTile) {
          target[row][col] = null;
          return next;
        }
        target[row][col] = { ...activeTile };
        return next;
      });
    },
    [activeLayer, activeTile, erasing],
  );

  const save = useCallback(async () => {
    if (!map) return;
    setSaveStatus("saving…");
    try {
      const r = await fetch("/api/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(map),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setSaveStatus(`saved ✓ ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveStatus(`save error: ${data.error ?? "unknown"}`);
      }
    } catch (err) {
      setSaveStatus(`save error: ${String(err)}`);
    }
  }, [map]);

  // Cmd/Ctrl-S keyboard shortcut for save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key === "s") {
        e.preventDefault();
        save();
      }
      if (e.key === "e" || e.key === "E") {
        const t = e.target as HTMLElement | null;
        if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
        setErasing((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (loading) {
    return (
      <div className="min-h-screen bg-page text-ink p-4 pixel-font text-[12px]">
        Loading map…
      </div>
    );
  }
  if (!map) {
    return (
      <div className="min-h-screen bg-page text-ink p-4 pixel-font text-[12px]">
        Map failed to load. {saveStatus}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-page text-ink flex flex-col">
      <Toolbar
        activeLayer={activeLayer}
        onLayer={setActiveLayer}
        erasing={erasing}
        onEraserToggle={() => setErasing((v) => !v)}
        zoom={zoom}
        onZoom={setZoom}
        saveStatus={saveStatus}
        onSave={save}
        activeTile={activeTile}
      />
      <div className="flex-1 grid grid-cols-[420px_1fr] min-h-0">
        <aside className="panel m-2 mr-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex gap-2 mb-2">
            <PaletteModeButton current={paletteMode} mine="named" onClick={setPaletteMode}>
              Named ({Object.keys(ALL_TILES).length})
            </PaletteModeButton>
            <PaletteModeButton current={paletteMode} mine="raw" onClick={setPaletteMode}>
              Raw atlas
            </PaletteModeButton>
          </div>
          {paletteMode === "named" ? (
            <NamedPalette active={activeTile} onPick={(s) => { setActiveTile(s); setErasing(false); }} />
          ) : (
            <RawPalette active={activeTile} onPick={(s) => { setActiveTile(s); setErasing(false); }} />
          )}
        </aside>
        <main className="panel m-2 ml-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex items-center gap-3 mb-2 text-[11px]">
            <span className="opacity-70">
              Click a cell to place the active tile. Drag to paint. Press{" "}
              <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">E</kbd>{" "}
              to toggle eraser. <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">⌘S</kbd> to save.
            </span>
            {hoverCell && (
              <span className="ml-auto pixel-font text-[10px] opacity-70 tabular-nums">
                ({hoverCell.col}, {hoverCell.row})
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto pixel-scroll bg-paper-dim/30 border-2 border-ink rounded">
            <Grid
              map={map}
              zoom={zoom}
              activeLayer={activeLayer}
              onPaint={placeAt}
              onHover={setHoverCell}
              isPaintingRef={isPaintingRef}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

// =============================================================================
// Toolbar
// =============================================================================

function Toolbar({
  activeLayer,
  onLayer,
  erasing,
  onEraserToggle,
  zoom,
  onZoom,
  saveStatus,
  onSave,
  activeTile,
}: {
  activeLayer: Layer;
  onLayer: (l: Layer) => void;
  erasing: boolean;
  onEraserToggle: () => void;
  zoom: number;
  onZoom: (n: number) => void;
  saveStatus: string;
  onSave: () => void;
  activeTile: AtlasSlice | null;
}) {
  return (
    <header className="title-strip px-4 py-1.5 flex items-center gap-3 flex-wrap">
      <h1 className="pixel-font text-[14px] tracking-wide">◆ MAP EDITOR</h1>
      <div className="flex items-center gap-1 ml-2">
        <LayerButton mine="floor" current={activeLayer} onClick={onLayer}>
          Floor
        </LayerButton>
        <LayerButton mine="decor" current={activeLayer} onClick={onLayer}>
          Decor
        </LayerButton>
      </div>
      <button
        onClick={onEraserToggle}
        className={`pixel-font text-[10px] px-3 py-1 rounded border-2 border-ink tracking-wide ${
          erasing ? "bg-red-300 text-ink" : "bg-paper hover:bg-paper-dim"
        }`}
        title="Toggle eraser (E)"
      >
        🧽 Eraser {erasing && "ON"}
      </button>
      <div className="flex items-center gap-2 ml-2">
        <label className="text-[11px] opacity-70">Zoom</label>
        <input
          type="range"
          min={1}
          max={4}
          step={1}
          value={zoom}
          onChange={(e) => onZoom(parseInt(e.target.value, 10))}
        />
        <span className="pixel-font text-[10px] tabular-nums w-6">{zoom}×</span>
      </div>
      {activeTile && !erasing && (
        <div className="flex items-center gap-2 ml-2 text-[11px]">
          <span className="opacity-60">Active:</span>
          <TileThumb slice={activeTile} scale={2} />
          <code className="bg-paper-dim border border-ink rounded px-1.5 py-0.5 text-[10px]">
            {activeTile.atlas} ({activeTile.col}, {activeTile.row})
          </code>
        </div>
      )}
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] opacity-70 italic">{saveStatus}</span>
        <button
          onClick={onSave}
          className="pixel-font text-[10px] px-3 py-1.5 rounded border-2 border-ink bg-accent text-ink hover:bg-accent-dark tracking-wide"
        >
          SAVE (⌘S)
        </button>
      </div>
    </header>
  );
}

function LayerButton({
  mine,
  current,
  onClick,
  children,
}: {
  mine: Layer;
  current: Layer;
  onClick: (l: Layer) => void;
  children: React.ReactNode;
}) {
  const active = current === mine;
  return (
    <button
      onClick={() => onClick(mine)}
      className={`pixel-font text-[10px] px-3 py-1 rounded border-2 border-ink tracking-wide ${
        active ? "bg-ink text-paper" : "bg-paper hover:bg-paper-dim"
      }`}
    >
      {children}
    </button>
  );
}

function PaletteModeButton({
  mine,
  current,
  onClick,
  children,
}: {
  mine: PaletteMode;
  current: PaletteMode;
  onClick: (m: PaletteMode) => void;
  children: React.ReactNode;
}) {
  const active = current === mine;
  return (
    <button
      onClick={() => onClick(mine)}
      className={`pixel-font text-[10px] px-3 py-1 rounded border-2 border-ink tracking-wide flex-1 ${
        active ? "bg-accent text-ink" : "bg-paper hover:bg-paper-dim"
      }`}
    >
      {children}
    </button>
  );
}

// =============================================================================
// Named palette — every TILE_* grouped by prefix
// =============================================================================

const CATEGORY_RULES: Array<{ label: string; match: (name: string) => boolean }> = [
  { label: "Floors", match: (n) => n.startsWith("FLOOR_") },
  { label: "Walls", match: (n) => n.startsWith("WALL_") },
  { label: "Doors", match: (n) => n.startsWith("DOOR_") },
  { label: "Office", match: (n) =>
      n.startsWith("DESK_") ||
      n.startsWith("OFFICE_") ||
      n.startsWith("MONITOR") ||
      n === "KEYBOARD_MOUSE" ||
      n === "FILE_CABINET" ||
      n === "SERVER_RACK" ||
      n === "PRINTER" ||
      n === "WATER_COOLER" ||
      n.startsWith("POSTER_") },
  { label: "Library", match: (n) =>
      n.startsWith("BOOKSHELF") || n === "READING_TABLE" || n === "CHALKBOARD" },
  { label: "Kitchen", match: (n) =>
      n === "FRIDGE" || n === "STOVE" || n === "KITCHEN_SINK" ||
      n.startsWith("COUNTER_") || n === "KITCHEN_TABLE" },
  { label: "Meeting", match: (n) =>
      n === "ROUND_TABLE" || n.startsWith("CONFERENCE_") || n === "WHITEBOARD" },
  { label: "Test rig", match: (n) =>
      n.startsWith("LAB_") || n === "MICROSCOPE" || n === "HOSPITAL_BED" },
  { label: "Lounge", match: (n) =>
      n.startsWith("COUCH_") || n === "COFFEE_TABLE" || n === "TV_STAND" || n === "LOUNGE_RUG" },
  { label: "Exterior", match: (n) =>
      n === "STONE_PATH" || n === "DIRT_PATH" },
];

function NamedPalette({
  active,
  onPick,
}: {
  active: AtlasSlice | null;
  onPick: (s: AtlasSlice) => void;
}) {
  const groups = useMemo(() => {
    const buckets: { label: string; entries: [string, AtlasSlice][] }[] =
      CATEGORY_RULES.map((c) => ({ label: c.label, entries: [] }));
    const other: [string, AtlasSlice][] = [];
    for (const [name, slice] of Object.entries(ALL_TILES)) {
      const idx = CATEGORY_RULES.findIndex((c) => c.match(name));
      if (idx === -1) other.push([name, slice]);
      else buckets[idx].entries.push([name, slice]);
    }
    if (other.length) buckets.push({ label: "Other", entries: other });
    return buckets.filter((b) => b.entries.length > 0);
  }, []);

  return (
    <div className="overflow-y-auto pixel-scroll flex-1 -mr-1 pr-1">
      {groups.map((g) => (
        <section key={g.label} className="mb-3">
          <div className="pixel-font text-[10px] tracking-wide opacity-70 mb-1">
            {g.label.toUpperCase()}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1">
            {g.entries.map(([name, slice]) => {
              const isActive = sameSlice(active, slice);
              return (
                <button
                  key={name}
                  onClick={() => onPick(slice)}
                  className={`flex flex-col items-center justify-center gap-1 p-1 rounded border-2 ${
                    isActive
                      ? "border-accent-dark bg-accent/30"
                      : "border-ink/30 hover:border-ink hover:bg-paper-dim"
                  }`}
                  title={`${name}\n${slice.atlas} (${slice.col}, ${slice.row})`}
                >
                  <TileThumb slice={slice} scale={2} />
                  <span className="text-[8px] leading-tight text-center break-all">
                    {name}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// =============================================================================
// Raw atlas palette — pick any cell from any atlas
// =============================================================================

function RawPalette({
  active,
  onPick,
}: {
  active: AtlasSlice | null;
  onPick: (s: AtlasSlice) => void;
}) {
  const [atlasKey, setAtlasKey] = useState<string>(manifest.atlases[0]?.key ?? "");
  const [scale, setScale] = useState(2);
  const atlas = ATLAS_BY_KEY.get(atlasKey);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <select
        value={atlasKey}
        onChange={(e) => setAtlasKey(e.target.value)}
        className="pixel-font text-[10px] px-2 py-1 border-2 border-ink rounded bg-paper"
      >
        {manifest.atlases.map((a) => (
          <option key={a.key} value={a.key}>
            {a.key} ({a.cols}×{a.rows})
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2 text-[11px]">
        <label className="opacity-70">Zoom</label>
        <input
          type="range"
          min={1}
          max={6}
          value={scale}
          onChange={(e) => setScale(parseInt(e.target.value, 10))}
        />
        <span className="pixel-font text-[10px] tabular-nums w-6">{scale}×</span>
      </div>
      {atlas && (
        <div className="flex-1 overflow-auto pixel-scroll bg-paper-dim/30 border-2 border-ink rounded">
          <RawAtlasGrid
            atlas={atlas}
            scale={scale}
            active={active}
            onPick={onPick}
          />
        </div>
      )}
    </div>
  );
}

function RawAtlasGrid({
  atlas,
  scale,
  active,
  onPick,
}: {
  atlas: (typeof manifest.atlases)[number];
  scale: number;
  active: AtlasSlice | null;
  onPick: (s: AtlasSlice) => void;
}) {
  const cellPx = TILE_PX * scale;
  const totalW = atlas.cols * cellPx;
  const totalH = atlas.rows * cellPx;
  const url = `${TILE_PUBLIC_PREFIX}/${atlas.file}`;
  return (
    <div
      className="relative pixelated"
      style={{
        width: totalW,
        height: totalH,
        backgroundImage: `url(${url})`,
        backgroundSize: `${totalW}px ${totalH}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    >
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${atlas.cols}, ${cellPx}px)`,
          gridTemplateRows: `repeat(${atlas.rows}, ${cellPx}px)`,
        }}
      >
        {Array.from({ length: atlas.cols * atlas.rows }, (_, i) => {
          const col = i % atlas.cols;
          const row = Math.floor(i / atlas.cols);
          const isActive =
            !!active &&
            active.atlas === atlas.key &&
            active.col === col &&
            active.row === row;
          return (
            <div
              key={i}
              onClick={() => onPick({ atlas: atlas.key, col, row })}
              title={`${atlas.key} (${col}, ${row})`}
              className={`box-border border cursor-crosshair ${
                isActive
                  ? "border-accent bg-accent/40"
                  : "border-transparent hover:border-accent-dark hover:bg-accent/20"
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// The 32×22 grid
// =============================================================================

function Grid({
  map,
  zoom,
  activeLayer,
  onPaint,
  onHover,
  isPaintingRef,
}: {
  map: MapPayload;
  zoom: number;
  activeLayer: Layer;
  onPaint: (col: number, row: number) => void;
  onHover: (cell: { col: number; row: number } | null) => void;
  isPaintingRef: React.MutableRefObject<boolean>;
}) {
  const cellPx = TILE_PX * zoom;
  const totalW = map.cols * cellPx;
  const totalH = map.rows * cellPx;

  return (
    <div
      className="relative pixelated"
      style={{ width: totalW, height: totalH, imageRendering: "pixelated" }}
      onMouseDown={() => {
        isPaintingRef.current = true;
      }}
      onMouseUp={() => {
        isPaintingRef.current = false;
      }}
      onMouseLeave={() => {
        isPaintingRef.current = false;
        onHover(null);
      }}
    >
      {/* Floor layer (under) */}
      <LayerView map={map} which="floor" cellPx={cellPx} />
      {/* Decor layer */}
      <LayerView map={map} which="decor" cellPx={cellPx} />
      {/* Click overlay */}
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${map.cols}, ${cellPx}px)`,
          gridTemplateRows: `repeat(${map.rows}, ${cellPx}px)`,
        }}
      >
        {Array.from({ length: map.cols * map.rows }, (_, i) => {
          const col = i % map.cols;
          const row = Math.floor(i / map.cols);
          // Tint cells that already have a slice on the *inactive* layer
          // very faintly so you can see what's there.
          return (
            <div
              key={i}
              className="box-border border border-ink/10 hover:border-accent-dark hover:bg-accent/20 cursor-crosshair"
              onMouseDown={(e) => {
                e.preventDefault();
                onPaint(col, row);
              }}
              onMouseEnter={() => {
                onHover({ col, row });
                if (isPaintingRef.current) onPaint(col, row);
              }}
            />
          );
        })}
      </div>
      <ActiveLayerBadge activeLayer={activeLayer} />
    </div>
  );
}

function LayerView({
  map,
  which,
  cellPx,
}: {
  map: MapPayload;
  which: Layer;
  cellPx: number;
}) {
  const layer = map[which];
  return (
    <div className="absolute inset-0 pointer-events-none">
      {layer.map((row, rowIdx) =>
        row.map((slice, colIdx) =>
          slice ? (
            <CellSprite
              key={`${which}-${rowIdx}-${colIdx}`}
              slice={slice}
              col={colIdx}
              row={rowIdx}
              cellPx={cellPx}
            />
          ) : null,
        ),
      )}
    </div>
  );
}

function CellSprite({
  slice,
  col,
  row,
  cellPx,
}: {
  slice: AtlasSlice;
  col: number;
  row: number;
  cellPx: number;
}) {
  const atlas = ATLAS_BY_KEY.get(slice.atlas);
  if (!atlas) return null;
  const spanC = slice.spanCols ?? 1;
  const spanR = slice.spanRows ?? 1;
  const url = `${TILE_PUBLIC_PREFIX}/${atlas.file}`;
  const atlasW = atlas.cols * cellPx;
  const atlasH = atlas.rows * cellPx;
  return (
    <div
      className="absolute pixelated"
      style={{
        left: col * cellPx,
        top: row * cellPx,
        width: cellPx * spanC,
        height: cellPx * spanR,
        backgroundImage: `url(${url})`,
        backgroundSize: `${atlasW}px ${atlasH}px`,
        backgroundPosition: `-${slice.col * cellPx}px -${slice.row * cellPx}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    />
  );
}

function ActiveLayerBadge({ activeLayer }: { activeLayer: Layer }) {
  return (
    <div className="absolute top-1 right-1 pixel-font text-[9px] px-2 py-0.5 rounded bg-ink text-paper pointer-events-none tracking-wide">
      LAYER: {activeLayer.toUpperCase()}
    </div>
  );
}

// =============================================================================
// Tile thumbnail — used in the toolbar + named palette buttons.
// =============================================================================

function TileThumb({
  slice,
  scale,
}: {
  slice: AtlasSlice;
  scale: number;
}) {
  const atlas = ATLAS_BY_KEY.get(slice.atlas);
  if (!atlas) return null;
  const url = `${TILE_PUBLIC_PREFIX}/${atlas.file}`;
  const cellPx = TILE_PX * scale;
  const spanC = slice.spanCols ?? 1;
  const spanR = slice.spanRows ?? 1;
  return (
    <div
      className="pixelated shrink-0"
      style={{
        width: cellPx * spanC,
        height: cellPx * spanR,
        backgroundImage: `url(${url})`,
        backgroundSize: `${atlas.cols * cellPx}px ${atlas.rows * cellPx}px`,
        backgroundPosition: `-${slice.col * cellPx}px -${slice.row * cellPx}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    />
  );
}

function sameSlice(a: AtlasSlice | null, b: AtlasSlice): boolean {
  if (!a) return false;
  return a.atlas === b.atlas && a.col === b.col && a.row === b.row;
}

// Resize / pad a loaded map to (cols, rows). Used after GET to coerce a
// stub or a partially-edited map into the canonical shape the editor
// uses for indexing.
function normalizeMap(raw: MapPayload): MapPayload {
  const cols = raw.cols || 32;
  const rows = raw.rows || 22;
  const grow = (
    layer: (AtlasSlice | null)[][] | undefined,
  ): (AtlasSlice | null)[][] => {
    const out: (AtlasSlice | null)[][] = [];
    for (let r = 0; r < rows; r++) {
      const sourceRow = (layer && layer[r]) || [];
      const newRow: (AtlasSlice | null)[] = new Array(cols).fill(null);
      for (let c = 0; c < cols; c++) {
        const cell = sourceRow[c];
        if (cell) newRow[c] = cell;
      }
      out.push(newRow);
    }
    return out;
  };
  return {
    cols,
    rows,
    tileSize: raw.tileSize || TILE_PX,
    floor: grow(raw.floor),
    decor: grow(raw.decor),
  };
}
