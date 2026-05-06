"use client";

// /map-editor — author the building's tile layout by clicking.
//
// Toolbar (top): mode toggle (paint/select), layer toggle, eraser, undo,
// save. Status shows active tile, selection size, clipboard size.
// Left panel: tile palette (Named tabs grouped by category, or Raw atlas
// browser). Right panel: 32×22 grid.
//
// Modes:
//   - paint : click/drag places the active tile on the active layer.
//   - select: shift+drag (or any drag in select mode) makes a rectangle.
//             ⌘C copies selection to clipboard. ⌘X cuts. Delete erases.
//   - paste : after ⌘V, cursor shows a ghost preview; click to stamp.
//             Stays in paste mode for repeat stamping until Esc.
//
// Persistence: GET /api/map → load. POST /api/map → save src/game/map.json.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import manifest from "../../game/limezu-manifest.json";
import { ALL_TILES } from "../../game/limezu-tiles";
import type { AtlasSlice } from "../../game/atlas";
import {
  normalizeRect,
  rectArea,
  rectContains,
  useMapEditor,
  type Clipboard,
  type EditorMode,
  type Layer,
  type MapPayload,
  type Rect,
} from "./useMapEditor";

type PaletteMode = "named" | "raw";

const ATLAS_BY_KEY = new Map<string, (typeof manifest.atlases)[number]>();
for (const a of manifest.atlases) ATLAS_BY_KEY.set(a.key, a);

const TILE_PUBLIC_PREFIX = manifest.publicPathPrefix;
const TILE_PX = manifest.tileSize;

// =============================================================================
// Page
// =============================================================================

export default function MapEditorPage() {
  const ed = useMapEditor();
  const {
    map,
    setMap,
    mode,
    setMode,
    activeLayer,
    setActiveLayer,
    activeTile,
    setActiveTile,
    erasing,
    setErasing,
    selection,
    setSelection,
    clipboard,
    applyOp,
    undo,
    canUndo,
    copySelection,
    cutSelection,
    enterPasteMode,
    exitPasteMode,
    paintAt,
    pasteAt,
    eraseSelection,
    duplicateSelection,
  } = ed;

  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<string>("");
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("named");
  const [zoom, setZoom] = useState(2);
  const [hoverCell, setHoverCell] = useState<{ col: number; row: number } | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);

  // Mouse-drag tracking — used by both paint mode (drag-paint) and select
  // mode (drag-select).
  const dragStateRef = useRef<{
    kind: "paint" | "select";
    startCell: { col: number; row: number };
  } | null>(null);

  // -------- Load on mount -------------------------------------------------

  useEffect(() => {
    let aborted = false;
    fetch("/api/map")
      .then((r) => r.json())
      .then((raw: MapPayload) => {
        if (aborted) return;
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
  }, [setMap]);

  // -------- Save ----------------------------------------------------------

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

  // -------- Keyboard shortcuts -------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;

      if (cmd && e.key === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (cmd && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (cmd && e.key === "c") {
        e.preventDefault();
        copySelection();
        return;
      }
      if (cmd && e.key === "x") {
        e.preventDefault();
        cutSelection();
        return;
      }
      if (cmd && e.key === "v") {
        e.preventDefault();
        enterPasteMode();
        return;
      }
      if (cmd && e.key === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (e.key === "Escape") {
        if (mode === "paste") exitPasteMode();
        else setSelection(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selection) {
          e.preventDefault();
          eraseSelection();
        }
        return;
      }
      if (e.key === "e" || e.key === "E") {
        setErasing(!erasing);
        return;
      }
      if (e.key === "v" || e.key === "V") {
        // V (no cmd) toggles select <-> paint, similar to Tiled
        setMode(mode === "select" ? "paint" : "select");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    save,
    undo,
    copySelection,
    cutSelection,
    enterPasteMode,
    duplicateSelection,
    eraseSelection,
    exitPasteMode,
    selection,
    mode,
    erasing,
    setMode,
    setSelection,
    setErasing,
  ]);

  // -------- Mouse interaction --------------------------------------------

  const onCellMouseDown = useCallback(
    (col: number, row: number, e: React.MouseEvent) => {
      // Paste mode: click stamps the clipboard at this anchor.
      if (mode === "paste") {
        pasteAt(col, row);
        return;
      }
      // Shift held → start a rectangle selection regardless of mode.
      if (e.shiftKey || mode === "select") {
        dragStateRef.current = { kind: "select", startCell: { col, row } };
        setSelection(normalizeRect({ col, row }, { col, row }));
        return;
      }
      // Default paint.
      dragStateRef.current = { kind: "paint", startCell: { col, row } };
      paintAt(col, row);
    },
    [mode, pasteAt, paintAt, setSelection],
  );

  const onCellMouseEnter = useCallback(
    (col: number, row: number) => {
      setHoverCell({ col, row });
      const drag = dragStateRef.current;
      if (!drag) return;
      if (drag.kind === "paint") {
        paintAt(col, row);
      } else if (drag.kind === "select") {
        setSelection(normalizeRect(drag.startCell, { col, row }));
      }
    },
    [paintAt, setSelection],
  );

  const onMouseUp = useCallback(() => {
    dragStateRef.current = null;
  }, []);

  // Cleanup hover on grid leave.
  const onGridLeave = useCallback(() => {
    setHoverCell(null);
    dragStateRef.current = null;
  }, []);

  // -------- Render -------------------------------------------------------

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
        mode={mode}
        onModeChange={setMode}
        activeLayer={activeLayer}
        onLayer={setActiveLayer}
        erasing={erasing}
        onEraserToggle={() => setErasing(!erasing)}
        zoom={zoom}
        onZoom={setZoom}
        saveStatus={saveStatus}
        onSave={save}
        canUndo={canUndo}
        onUndo={undo}
        activeTile={activeTile}
        selection={selection}
        clipboard={clipboard}
        onOpenGenerator={() => setShowGenerator(true)}
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
            <NamedPalette
              active={activeTile}
              onPick={(s) => {
                setActiveTile(s);
                setErasing(false);
                setMode("paint");
              }}
            />
          ) : (
            <RawPalette
              active={activeTile}
              onPick={(s) => {
                setActiveTile(s);
                setErasing(false);
                setMode("paint");
              }}
            />
          )}
        </aside>
        <main className="panel m-2 ml-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex items-center gap-3 mb-2 text-[11px]">
            <ModeHelp mode={mode} hasSelection={!!selection} hasClipboard={!!clipboard} />
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
              selection={selection}
              clipboard={mode === "paste" ? clipboard : null}
              hoverCell={hoverCell}
              mode={mode}
              onCellMouseDown={onCellMouseDown}
              onCellMouseEnter={onCellMouseEnter}
              onMouseUp={onMouseUp}
              onGridLeave={onGridLeave}
            />
          </div>
        </main>
      </div>
      {showGenerator && (
        <GeneratorDialog
          onClose={() => setShowGenerator(false)}
          onMapUpdated={(payload) => {
            setMap(normalizeMap(payload));
            setSaveStatus(`agent saved · ${new Date().toLocaleTimeString()}`);
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// Toolbar
// =============================================================================

function Toolbar({
  mode,
  onModeChange,
  activeLayer,
  onLayer,
  erasing,
  onEraserToggle,
  zoom,
  onZoom,
  saveStatus,
  onSave,
  canUndo,
  onUndo,
  activeTile,
  selection,
  clipboard,
  onOpenGenerator,
}: {
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  activeLayer: Layer;
  onLayer: (l: Layer) => void;
  erasing: boolean;
  onEraserToggle: () => void;
  zoom: number;
  onZoom: (n: number) => void;
  saveStatus: string;
  onSave: () => void;
  canUndo: boolean;
  onUndo: () => void;
  activeTile: AtlasSlice | null;
  selection: Rect | null;
  clipboard: Clipboard | null;
  onOpenGenerator: () => void;
}) {
  return (
    <header className="title-strip px-4 py-1.5 flex items-center gap-3 flex-wrap">
      <h1 className="pixel-font text-[14px] tracking-wide">◆ MAP EDITOR</h1>
      <div className="flex items-center gap-1">
        <ModeButton mine="paint" current={mode} onClick={onModeChange}>
          ✏️ Paint
        </ModeButton>
        <ModeButton mine="select" current={mode} onClick={onModeChange}>
          ⬚ Select (V)
        </ModeButton>
        {mode === "paste" && (
          <span className="pixel-font text-[10px] px-3 py-1 rounded border-2 border-accent-dark bg-accent text-ink tracking-wide">
            📋 PASTE — click to stamp · Esc to exit
          </span>
        )}
      </div>
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
        🧽 Eraser{erasing && " ON"}
      </button>
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="pixel-font text-[10px] px-3 py-1 rounded border-2 border-ink tracking-wide bg-paper hover:bg-paper-dim disabled:opacity-40"
        title="Undo (⌘Z)"
      >
        ↶ Undo
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
      {activeTile && !erasing && mode !== "paste" && (
        <div className="flex items-center gap-2 ml-2 text-[11px]">
          <span className="opacity-60">Tile:</span>
          <TileThumb slice={activeTile} scale={2} />
          <code className="bg-paper-dim border border-ink rounded px-1.5 py-0.5 text-[10px]">
            {activeTile.atlas} ({activeTile.col}, {activeTile.row})
          </code>
        </div>
      )}
      {selection && (
        <span className="text-[11px] opacity-70">
          Sel: {selection.colMax - selection.colMin + 1}×{selection.rowMax - selection.rowMin + 1}{" "}
          ({rectArea(selection)} cells)
        </span>
      )}
      {clipboard && (
        <span className="text-[11px] opacity-70">
          Clip: {clipboard.cols}×{clipboard.rows}
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] opacity-70 italic">{saveStatus}</span>
        <button
          onClick={onOpenGenerator}
          className="pixel-font text-[10px] px-3 py-1.5 rounded border-2 border-ink bg-paper hover:bg-paper-dim tracking-wide"
          title="Ask Claude to build a map"
        >
          ✨ GENERATE
        </button>
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

function ModeButton({
  mine,
  current,
  onClick,
  children,
}: {
  mine: EditorMode;
  current: EditorMode;
  onClick: (m: EditorMode) => void;
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

function ModeHelp({
  mode,
  hasSelection,
  hasClipboard,
}: {
  mode: EditorMode;
  hasSelection: boolean;
  hasClipboard: boolean;
}) {
  if (mode === "paint") {
    return (
      <span className="opacity-70">
        Click/drag to paint. <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">Shift</kbd>+drag to select.
        <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded ml-2">E</kbd> eraser.
        <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded ml-2">⌘Z</kbd> undo.
        <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded ml-2">⌘S</kbd> save.
      </span>
    );
  }
  if (mode === "select") {
    return (
      <span className="opacity-70">
        Drag to select.{" "}
        {hasSelection && (
          <>
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">⌘C</kbd> copy ·{" "}
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">⌘X</kbd> cut ·{" "}
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">⌫</kbd> erase ·{" "}
          </>
        )}
        {hasClipboard && (
          <>
            <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">⌘V</kbd> paste ·{" "}
          </>
        )}
        <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">Esc</kbd> clear.
      </span>
    );
  }
  return (
    <span className="opacity-70">
      Click to stamp the clipboard.{" "}
      <kbd className="pixel-font px-1 bg-paper-dim border border-ink rounded">Esc</kbd> exit paste.
    </span>
  );
}

// =============================================================================
// Named palette
// =============================================================================

const CATEGORY_RULES: Array<{ label: string; match: (name: string) => boolean }> = [
  { label: "Floors", match: (n) => n.startsWith("FLOOR_") },
  { label: "Walls", match: (n) => n.startsWith("WALL_") },
  { label: "Doors", match: (n) => n.startsWith("DOOR_") },
  {
    label: "Office",
    match: (n) =>
      n.startsWith("DESK_") ||
      n.startsWith("OFFICE_") ||
      n.startsWith("MONITOR") ||
      n === "KEYBOARD_MOUSE" ||
      n === "FILE_CABINET" ||
      n === "SERVER_RACK" ||
      n === "PRINTER" ||
      n === "WATER_COOLER" ||
      n.startsWith("POSTER_"),
  },
  {
    label: "Library",
    match: (n) => n.startsWith("BOOKSHELF") || n === "READING_TABLE" || n === "CHALKBOARD",
  },
  {
    label: "Kitchen",
    match: (n) =>
      n === "FRIDGE" ||
      n === "STOVE" ||
      n === "KITCHEN_SINK" ||
      n.startsWith("COUNTER_") ||
      n === "KITCHEN_TABLE",
  },
  {
    label: "Meeting",
    match: (n) => n === "ROUND_TABLE" || n.startsWith("CONFERENCE_") || n === "WHITEBOARD",
  },
  {
    label: "Test rig",
    match: (n) => n.startsWith("LAB_") || n === "MICROSCOPE" || n === "HOSPITAL_BED",
  },
  {
    label: "Lounge",
    match: (n) =>
      n.startsWith("COUCH_") ||
      n === "COFFEE_TABLE" ||
      n === "TV_STAND" ||
      n === "LOUNGE_RUG",
  },
  { label: "Exterior", match: (n) => n === "STONE_PATH" || n === "DIRT_PATH" },
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
                  <span className="text-[8px] leading-tight text-center break-all">{name}</span>
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
// Raw palette
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
          <RawAtlasGrid atlas={atlas} scale={scale} active={active} onPick={onPick} />
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
            !!active && active.atlas === atlas.key && active.col === col && active.row === row;
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
// Grid
// =============================================================================

function Grid({
  map,
  zoom,
  activeLayer,
  selection,
  clipboard,
  hoverCell,
  mode,
  onCellMouseDown,
  onCellMouseEnter,
  onMouseUp,
  onGridLeave,
}: {
  map: MapPayload;
  zoom: number;
  activeLayer: Layer;
  selection: Rect | null;
  clipboard: Clipboard | null;
  hoverCell: { col: number; row: number } | null;
  mode: EditorMode;
  onCellMouseDown: (col: number, row: number, e: React.MouseEvent) => void;
  onCellMouseEnter: (col: number, row: number) => void;
  onMouseUp: () => void;
  onGridLeave: () => void;
}) {
  const cellPx = TILE_PX * zoom;
  const totalW = map.cols * cellPx;
  const totalH = map.rows * cellPx;

  // Track the global mouse-up so dragging out and releasing still ends the
  // gesture cleanly.
  useEffect(() => {
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [onMouseUp]);

  return (
    <div
      className="relative pixelated"
      style={{ width: totalW, height: totalH, imageRendering: "pixelated" }}
      onMouseLeave={onGridLeave}
    >
      <LayerView map={map} which="floor" cellPx={cellPx} />
      <LayerView map={map} which="decor" cellPx={cellPx} />

      {/* Paste-mode ghost preview */}
      {mode === "paste" && clipboard && hoverCell && (
        <ClipboardGhost
          clip={clipboard}
          anchor={hoverCell}
          cellPx={cellPx}
          mapCols={map.cols}
          mapRows={map.rows}
        />
      )}

      {/* Selection rect overlay */}
      {selection && (
        <SelectionOverlay rect={selection} cellPx={cellPx} />
      )}

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
          return (
            <div
              key={i}
              className="box-border border border-ink/10 hover:border-accent-dark hover:bg-accent/20 cursor-crosshair"
              onMouseDown={(e) => {
                e.preventDefault();
                onCellMouseDown(col, row, e);
              }}
              onMouseEnter={() => onCellMouseEnter(col, row)}
            />
          );
        })}
      </div>
      <ActiveLayerBadge activeLayer={activeLayer} mode={mode} />
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

function SelectionOverlay({ rect, cellPx }: { rect: Rect; cellPx: number }) {
  const w = (rect.colMax - rect.colMin + 1) * cellPx;
  const h = (rect.rowMax - rect.rowMin + 1) * cellPx;
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: rect.colMin * cellPx,
        top: rect.rowMin * cellPx,
        width: w,
        height: h,
        outline: "2px dashed var(--accent-dark, #8b5a3c)",
        outlineOffset: -1,
        background: "rgba(201, 169, 89, 0.12)",
        zIndex: 30,
      }}
    />
  );
}

function ClipboardGhost({
  clip,
  anchor,
  cellPx,
  mapCols,
  mapRows,
}: {
  clip: Clipboard;
  anchor: { col: number; row: number };
  cellPx: number;
  mapCols: number;
  mapRows: number;
}) {
  return (
    <div className="absolute pointer-events-none" style={{ zIndex: 40, opacity: 0.6 }}>
      {/* Floor first, then decor — same render order as the main grid. */}
      {(["floor", "decor"] as Layer[]).flatMap((layerKey) =>
        clip[layerKey].flatMap((row, dr) =>
          row.map((slice, dc) => {
            if (!slice) return null;
            const c = anchor.col + dc;
            const r = anchor.row + dr;
            if (r < 0 || r >= mapRows || c < 0 || c >= mapCols) return null;
            return (
              <CellSprite
                key={`ghost-${layerKey}-${dr}-${dc}`}
                slice={slice}
                col={c}
                row={r}
                cellPx={cellPx}
              />
            );
          }),
        ),
      )}
      {/* Outline of the paste area */}
      <div
        className="absolute"
        style={{
          left: anchor.col * cellPx,
          top: anchor.row * cellPx,
          width: clip.cols * cellPx,
          height: clip.rows * cellPx,
          outline: "2px dashed var(--accent-dark, #8b5a3c)",
          outlineOffset: -1,
          background: "rgba(139, 90, 60, 0.08)",
        }}
      />
    </div>
  );
}

function ActiveLayerBadge({ activeLayer, mode }: { activeLayer: Layer; mode: EditorMode }) {
  return (
    <div className="absolute top-1 right-1 pixel-font text-[9px] px-2 py-0.5 rounded bg-ink text-paper pointer-events-none tracking-wide">
      {mode.toUpperCase()} · {activeLayer.toUpperCase()}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function TileThumb({ slice, scale }: { slice: AtlasSlice; scale: number }) {
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

// rectContains is exported from the hook for future use; suppress unused.
void rectContains;

// =============================================================================
// Generator dialog — POSTs to /api/map/agent and renders the SSE stream.
// =============================================================================

interface AgentEvent {
  type: "text" | "tool_use" | "tool_result" | "map_updated" | "done" | "error";
  text?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  message?: string;
  reason?: string;
  floor?: (AtlasSlice | null)[][];
  decor?: (AtlasSlice | null)[][];
}

function GeneratorDialog({
  onClose,
  onMapUpdated,
}: {
  onClose: () => void;
  onMapUpdated: (m: MapPayload) => void;
}) {
  const [prompt, setPrompt] = useState(
    "Build a small office: a corridor with 3 rooms (one library with bookshelves, one kitchen, one meeting room with a round table). Surround with walls. South-facing front door.",
  );
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  const start = useCallback(async () => {
    setEvents([]);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/map/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({ error: "request failed" }));
        setEvents((e) => [...e, { type: "error", message: errBody.error ?? `HTTP ${res.status}` }]);
        setRunning(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Parse the SSE stream — events are `data: {...}\n\n`.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) {
              const json = line.slice(5).trim();
              if (!json) continue;
              try {
                const ev = JSON.parse(json) as AgentEvent;
                setEvents((prev) => [...prev, ev]);
                if (ev.type === "map_updated" && ev.floor && ev.decor) {
                  onMapUpdated({
                    cols: 32,
                    rows: 22,
                    tileSize: 16,
                    floor: ev.floor,
                    decor: ev.decor,
                  });
                }
                if (ev.type === "done" || ev.type === "error") {
                  setRunning(false);
                }
              } catch {
                // ignore malformed event
              }
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!ctrl.signal.aborted) {
        setEvents((e) => [...e, { type: "error", message: msg }]);
      }
    } finally {
      setRunning(false);
    }
  }, [prompt, onMapUpdated]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="dialog-box w-[min(92vw,720px)] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="pixel-font text-[13px] text-accent-dark">
            ✨ AI MAP GENERATOR
          </h2>
          <button
            onClick={onClose}
            className="pixel-font text-[9px] text-ink-soft hover:text-ink underline"
          >
            [CLOSE]
          </button>
        </div>
        <div className="text-[11px] opacity-75 mb-2">
          Claude reads the current map and edits it via tool calls
          (placeTile, fillRect, eraseRect, commit). Save state is persisted
          when the agent calls commit. Set <code>ANTHROPIC_API_KEY</code> in
          the dev-server env before running.
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full text-[12px] p-2 mb-3 border-2 border-ink rounded bg-paper resize-vertical"
          placeholder="Describe the map you want…"
          disabled={running}
        />
        <div className="flex items-center gap-2 mb-3">
          {!running ? (
            <button
              onClick={start}
              className="pixel-font text-[10px] px-3 py-1.5 rounded border-2 border-ink bg-accent text-ink hover:bg-accent-dark tracking-wide"
            >
              ▶ RUN AGENT
            </button>
          ) : (
            <button
              onClick={stop}
              className="pixel-font text-[10px] px-3 py-1.5 rounded border-2 border-ink bg-red-300 text-ink tracking-wide"
            >
              ⏹ STOP
            </button>
          )}
          <span className="text-[11px] opacity-70 italic">
            {running ? "Streaming…" : `${events.length} events`}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto pixel-scroll border-2 border-ink rounded p-2 bg-paper-dim/30 text-[11px] font-mono leading-relaxed">
          {events.length === 0 && !running && (
            <div className="opacity-50 italic">No events yet. Hit RUN AGENT.</div>
          )}
          {events.map((e, i) => (
            <AgentEventLine key={i} event={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentEventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "text":
      return (
        <div className="opacity-80">
          <span className="opacity-50">› </span>
          {event.text}
        </div>
      );
    case "tool_use":
      return (
        <div className="my-1">
          <span className="pixel-font text-[9px] px-1.5 py-0.5 rounded bg-accent-dark text-paper tracking-wide">
            TOOL
          </span>{" "}
          <code className="font-bold">{event.name}</code>{" "}
          <code className="opacity-60 break-all">
            {truncate(JSON.stringify(event.input), 120)}
          </code>
        </div>
      );
    case "tool_result": {
      const r = event.result as { error?: string; painted?: number; ok?: boolean } | null;
      const isError = r && typeof r === "object" && "error" in r && r.error;
      return (
        <div className={`pl-4 ${isError ? "text-red-400" : "opacity-60"}`}>
          ↳ {truncate(JSON.stringify(r ?? null), 200)}
        </div>
      );
    }
    case "map_updated":
      return (
        <div className="text-emerald-400">
          ✓ map.json updated · refreshing editor
        </div>
      );
    case "done":
      return (
        <div className="text-emerald-400 mt-2">
          ✓ DONE — {event.reason ?? ""}
        </div>
      );
    case "error":
      return <div className="text-red-400 mt-2">✗ ERROR — {event.message}</div>;
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
