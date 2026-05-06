"use client";

// Atlas inspector — visit /atlas in dev to browse every loaded LimeZu
// sprite sheet with a coordinate grid overlay. Used to pick the exact
// (col, row) for each TILE_* slice when authoring layouts.
//
// Three view modes:
//   - "all": one card per atlas, full PNG, hover shows (col, row).
//   - "grid": tile-by-tile slice view at chunky scale for picking.
//   - "characters": premade-character sheets at scale.
//
// Hover any cell to copy its `{atlas, col, row}` to clipboard.

import { useMemo, useState } from "react";
import manifest from "../../game/limezu-manifest.json";

type AtlasEntry = (typeof manifest.atlases)[number];
type CharacterEntry = (typeof manifest.characters)[number];

type Mode = "atlases" | "characters";

const TILE_SIZE = manifest.tileSize;

export default function AtlasInspectorPage() {
  const [mode, setMode] = useState<Mode>("atlases");
  const [scale, setScale] = useState<number>(2);
  const [activeAtlas, setActiveAtlas] = useState<string>(
    manifest.atlases[0]?.key ?? "",
  );
  const [hover, setHover] = useState<{
    atlas: string;
    col: number;
    row: number;
  } | null>(null);

  const activeEntry = useMemo<AtlasEntry | undefined>(
    () => manifest.atlases.find((a) => a.key === activeAtlas),
    [activeAtlas],
  );

  return (
    <div className="min-h-screen bg-page text-ink p-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="pixel-font text-[16px] tracking-wide">
          ◆ ATLAS INSPECTOR
        </h1>
        <span className="text-[11px] opacity-70">
          Hover a cell to see its <code>(col, row)</code>. Click to copy.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ModeButton current={mode} mine="atlases" onClick={setMode}>
            Atlases ({manifest.atlases.length})
          </ModeButton>
          <ModeButton current={mode} mine="characters" onClick={setMode}>
            Characters ({manifest.characters.length})
          </ModeButton>
        </div>
      </header>

      {mode === "atlases" && (
        <div className="grid grid-cols-[220px_1fr] gap-4">
          <nav className="panel flex flex-col gap-1 max-h-[80vh] overflow-y-auto pixel-scroll">
            {manifest.atlases.map((a) => (
              <button
                key={a.key}
                onClick={() => setActiveAtlas(a.key)}
                className={`text-left text-[11px] px-2 py-1.5 rounded hover:bg-paper-dim ${
                  activeAtlas === a.key
                    ? "bg-paper-dim border-l-4 border-accent-dark pl-1"
                    : ""
                }`}
                title={a.purpose}
              >
                <div className="pixel-font text-[10px] truncate">{a.key}</div>
                <div className="opacity-60 text-[10px]">
                  {a.cols} × {a.rows} tiles
                </div>
              </button>
            ))}
          </nav>

          <section className="panel flex flex-col">
            {activeEntry && (
              <>
                <div className="flex flex-wrap items-baseline gap-3 mb-3">
                  <h2 className="pixel-font text-[12px]">{activeEntry.key}</h2>
                  <span className="text-[11px] opacity-70">
                    {activeEntry.cols} × {activeEntry.rows} tiles ·{" "}
                    {activeEntry.pixelWidth} × {activeEntry.pixelHeight} px
                  </span>
                  <span className="text-[11px] italic opacity-60 truncate">
                    {activeEntry.purpose}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <label className="text-[11px] opacity-70">Zoom</label>
                    <input
                      type="range"
                      min={1}
                      max={6}
                      step={1}
                      value={scale}
                      onChange={(e) => setScale(parseInt(e.target.value, 10))}
                    />
                    <span className="pixel-font text-[10px] tabular-nums w-8">
                      {scale}×
                    </span>
                  </div>
                </div>

                <div
                  className="overflow-auto pixel-scroll border-2 border-ink rounded bg-paper-dim/60"
                  style={{ maxHeight: "70vh" }}
                >
                  <AtlasGrid
                    atlas={activeEntry}
                    scale={scale}
                    onHover={(col, row) =>
                      setHover({ atlas: activeEntry.key, col, row })
                    }
                  />
                </div>

                <HoverInfo hover={hover} />
              </>
            )}
          </section>
        </div>
      )}

      {mode === "characters" && (
        <div className="panel">
          <div className="flex flex-wrap items-baseline gap-3 mb-3">
            <h2 className="pixel-font text-[12px]">Premade characters</h2>
            <span className="text-[11px] opacity-70">
              Each sheet is one character with all animations stacked. The
              top-left 3×4-frame block is the walk cycle (down/up/left/right
              × 3 frames). We&apos;ll use frame {0}, {1}, {2} for walk-down
              etc when wiring NPCs.
            </span>
            <div className="ml-auto flex items-center gap-2">
              <label className="text-[11px] opacity-70">Zoom</label>
              <input
                type="range"
                min={1}
                max={4}
                step={1}
                value={scale}
                onChange={(e) => setScale(parseInt(e.target.value, 10))}
              />
              <span className="pixel-font text-[10px] tabular-nums w-8">
                {scale}×
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {manifest.characters.map((c) => (
              <CharacterCard key={c.key} character={c} scale={scale} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeButton({
  mine,
  current,
  onClick,
  children,
}: {
  mine: Mode;
  current: Mode;
  onClick: (m: Mode) => void;
  children: React.ReactNode;
}) {
  const active = current === mine;
  return (
    <button
      onClick={() => onClick(mine)}
      className={`pixel-font text-[10px] px-3 py-1.5 rounded border-2 border-ink tracking-wide ${
        active ? "bg-accent text-ink" : "bg-paper hover:bg-paper-dim"
      }`}
    >
      {children}
    </button>
  );
}

function AtlasGrid({
  atlas,
  scale,
  onHover,
}: {
  atlas: AtlasEntry;
  scale: number;
  onHover: (col: number, row: number) => void;
}) {
  const cellPx = TILE_SIZE * scale;
  const totalW = atlas.cols * cellPx;
  const totalH = atlas.rows * cellPx;
  const url = `${manifest.publicPathPrefix}/${atlas.file}`;
  const [copied, setCopied] = useState<string | null>(null);

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
      onMouseLeave={() => onHover(-1, -1)}
    >
      {/* Hover-detection overlay: one transparent div per cell. */}
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
          const label = `(${col}, ${row})`;
          const isCopied = copied === label;
          return (
            <div
              key={i}
              onMouseEnter={() => onHover(col, row)}
              onClick={() => {
                const payload = JSON.stringify({
                  atlas: atlas.key,
                  col,
                  row,
                });
                void navigator.clipboard.writeText(payload).then(() => {
                  setCopied(label);
                  setTimeout(() => setCopied(null), 800);
                });
              }}
              title={`${atlas.key} ${label} — click to copy`}
              className={`box-border border border-transparent hover:border-accent-dark hover:bg-accent/20 cursor-crosshair ${
                isCopied ? "border-accent bg-accent/40" : ""
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

function CharacterCard({
  character,
  scale,
}: {
  character: CharacterEntry;
  scale: number;
}) {
  // Render the full sheet at the chosen scale so the user can see the
  // animation stack. We don't try to crop just one frame — picking the
  // right frame indices is what limezu-tiles.ts will codify later.
  const url = `${manifest.publicPathPrefix}/${character.file}`;
  const w = character.pixelWidth * scale;
  const h = character.pixelHeight * scale;
  return (
    <div className="bg-paper-dim/60 border-2 border-ink rounded p-2 flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="pixel-font text-[10px]">{character.key}</span>
        <span className="text-[10px] opacity-60 tabular-nums">
          {character.cols}×{character.rows}
        </span>
      </div>
      <div className="overflow-auto pixel-scroll border border-ink/40 bg-paper-dim/30">
        <div
          className="pixelated"
          style={{
            width: w,
            height: h,
            backgroundImage: `url(${url})`,
            backgroundSize: `${w}px ${h}px`,
            backgroundRepeat: "no-repeat",
            imageRendering: "pixelated",
          }}
        />
      </div>
    </div>
  );
}

function HoverInfo({
  hover,
}: {
  hover: { atlas: string; col: number; row: number } | null;
}) {
  if (!hover || hover.col < 0) return <div className="h-7 mt-2" />;
  return (
    <div className="mt-2 flex items-center gap-3 text-[11px]">
      <span className="pixel-font text-[10px] tracking-wide opacity-70">
        HOVER
      </span>
      <code className="bg-paper-dim border border-ink rounded px-2 py-0.5">
        {`{ atlas: "${hover.atlas}", col: ${hover.col}, row: ${hover.row} }`}
      </code>
      <span className="opacity-60">click to copy</span>
    </div>
  );
}

