import Phaser from "phaser";
import type { AgentEvent, AnimationId, RoomId } from "../events/types";
import {
  emojiForActivity,
  ERROR_EMOJI,
  IDLE_EMOJI,
  PROMPT_EMOJI,
} from "../events/stateToRoom";
import { useAgentStore } from "../stores/useAgentStore";
import { useGameStore } from "../stores/useGameStore";
import { buildLiveGreeting, useNpcStore } from "../stores/useNpcStore";
import { useWorldBus } from "../stores/useWorldBus";
import { GB, TILE_SIZE } from "./palette";
import { type NpcDef } from "./npcs";
import { bfs } from "./pathfind";
import { ROOM_ANCHORS, getRoomRegions } from "./rooms";
import { roomById } from "./room-registry";
import {
  EXTERIOR_ANCHORS,
  isWalkableIn,
  loadInteriorZone,
  type ZoneDef,
} from "./zones";
import { resolveGid, type SeatCell } from "./tiled-loader";
import {
  type ChoreoHandle,
  type ChoreoKind,
  startChoreo,
} from "./choreo";

type Direction = "down" | "up" | "left" | "right";

// Viewport (canvas) size — smaller than the full interior map so the camera
// has room to pan as the player walks. 20×12 tiles = 320×192 native; on the
// 24×16 interior map that leaves 4×4 tiles of scroll room. Picked to reveal
// more of the surroundings (top, left, right) without giving away the whole
// floorplan at once.
const VIEWPORT_COLS = 22;
const VIEWPORT_ROWS = 12;
const NATIVE_W = VIEWPORT_COLS * TILE_SIZE;
const NATIVE_H = VIEWPORT_ROWS * TILE_SIZE;

const TILESET_KEY = "gb_tileset";

// Modern (Limezu) character spritesheets. Each PNG is 384×32 = 24 frames
// (16×16 per frame), organized as 6 frames per direction in the order
// down → up → left → right. We load all four characters once at preload
// time, then ensureNpcTexture picks one per agent by id-hash so each
// claude session gets a stable, distinct sprite.
const MODERN_CHARS = ["Adam", "Alex", "Amelia", "Bob"] as const;
type ModernChar = (typeof MODERN_CHARS)[number];
const MODERN_KEY = (c: ModernChar) => `modern_${c.toLowerCase()}`;
// Idle / sit are separate spritesheets; their frame counts and layouts
// match `*_run_16x16.png` (24 frames × 16w × 32h). We give each its own
// Phaser texture key so animations can pull frames from the right sheet.
const MODERN_IDLE_KEY = (c: ModernChar) => `modern_${c.toLowerCase()}_idle`;
const MODERN_SIT_KEY = (c: ModernChar) => `modern_${c.toLowerCase()}_sit`;
const NPC_KEY = (id: string) => `gb_npc_${id}`;

// Recolor palette — applied as a sprite tint so two agents on the same
// base character still read as different people. Picked to stay legible
// against the dark indigo floor without crushing the line art.
const AGENT_TINTS = [
  0xffffff, // no tint (preserves the authored colors)
  0xffd1a4, // warm sand
  0xa9d6ff, // sky
  0xffb1d2, // pink
  0xc9e7a4, // lime
  0xd4b4ff, // lavender
  0xffe17a, // amber
  0xa3e3d6, // mint
] as const;

const STEP_DURATION_MS = 160;

// Frame indices into the Limezu 24-frame run sheet (6 per direction).
// We use 2 frames per direction for the walk anim — the first and middle
// frame of the run cycle, which gives a clean step bob without looking
// frantic at our 7 fps animation rate.
const FRAME = {
  down: [0, 3],
  up: [6, 9],
  left: [12, 15],
  right: [18, 21],
} as const;

// Idle-animation frame ranges. Each direction has 6 idle frames in the
// `*_idle_anim_16x16.png` sheet (same 24-frame layout as run). We use a
// 4-frame loop per direction (skipping a couple to keep the cycle calm).
const IDLE_FRAME = {
  down: [0, 1, 2, 3],
  up: [6, 7, 8, 9],
  left: [12, 13, 14, 15],
  right: [18, 19, 20, 21],
} as const;

// First frame per direction in the sit sheet — used as a static pose
// when an idle agent claims a seat.
const SIT_FRAME = {
  down: 0,
  up: 6,
  left: 12,
  right: 18,
} as const;

// Camera control constants (v2.0 free-pan mode).
const DRAG_THRESHOLD_PX = 4;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

/** Label shown on the always-on overhead pill. Prefers the basename
 *  of the agent's working directory (so you see WHAT the agent is
 *  working on, e.g. "agentquest" or "marketing-site"), then the
 *  agent's display name, then a stable 4-char id suffix as a last
 *  resort. Truncated to 14 chars so the pill stays compact. */
function pillLabelFor(def: {
  id: string;
  name?: string;
  cwd?: string;
}): string {
  if (def.cwd) {
    const base = def.cwd.split(/[/\\]/).filter(Boolean).pop();
    if (base) return base.slice(0, 14);
  }
  if (def.name && def.name.trim()) return def.name.slice(0, 14);
  const tail = def.id.replace(/[^A-Za-z0-9]/g, "").slice(-4);
  return tail.toUpperCase() || "??";
}

interface Entity {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Rectangle;
  indicator?: Phaser.GameObjects.Text;
  // Always-on overhead pill: a small rounded rect showing the agent's short
  // code + an emoji reflecting the current tool or state. Re-rendered on
  // every activity update; repositioned each frame in update().
  overheadContainer?: Phaser.GameObjects.Container;
  overheadBg?: Phaser.GameObjects.Graphics;
  overheadCodeText?: Phaser.GameObjects.Text;
  overheadEmojiText?: Phaser.GameObjects.Text;
  // Transient error flash: when a tool_result with isError arrives we swap
  // the emoji to ❌ for 800 ms then return to this baseline.
  overheadBaselineEmoji?: string;
  overheadErrorUntil?: number;
  // Transient "user just spoke" flash — 📨 for a couple seconds when a
  // UserPromptSubmit hook fires. Decays the same way as the error flash.
  overheadPromptUntil?: number;
  col: number;
  row: number;
  facing: Direction;
  animKey: string; // prefix used for this entity's anims
  // Texture key for this NPC's idle-loop sheet. Played as the resting
  // animation when the agent is not walking, choreoing, or sitting.
  idleAnimKey: string;
  // Texture key for the seated pose sheet (frame indexed by SIT_FRAME).
  sitSheetKey: string;
  // Baseline sprite scale between choreos. 1 for normal NPCs, 0.8 for
  // sub-agents so they read as smaller/subordinate even at rest. Choreo
  // startChoreoFor/stop must respect this to avoid snapping back to 1.
  restingScale: number;
  // Active per-tool choreography (set by subscribeStores on activity events).
  choreo?: { kind: ChoreoKind; handle: ChoreoHandle; startedAt: number };
  // Helper sprite spawned while the agent is running a `Task` (sub-agent).
  helper?: HelperSprite;
  // Floating "HELPER" badge above sub-agent sprites (parented NPCs only).
  helperBadge?: Phaser.GameObjects.Text;
  // Floating thinking excerpt — appears below the pill while
  // `thinkingByAgent[id]` has fresh content. Long text scrolls
  // marquee-style inside a fixed-width clipped container so the user
  // sees the full message over time. Auto-fades after TTL of no
  // updates so a stale "thinking..." line doesn't sit there forever.
  thinkingBadge?: {
    container: Phaser.GameObjects.Container;
    bg: Phaser.GameObjects.Graphics;
    text: Phaser.GameObjects.Text;
    maskGfx: Phaser.GameObjects.Graphics;
    pixelWidth: number;
    boxWidth: number;
    boxHeight: number;
  };
  thinkingText?: string;
  thinkingUpdatedAt?: number;
  // Where this NPC is currently walking. Set by walkNpcToRoom and
  // cleared once the path drains; read by the transit indicator badge.
  transitTarget?: RoomId;
  transitBadge?: Phaser.GameObjects.Text;
  transitText?: string;
  // Hover state: when true the pill renders the name + emoji + bg;
  // when false only the emoji shows so the world looks less busy.
  pillHover?: boolean;
}

interface HelperSprite {
  sprite: Phaser.GameObjects.Sprite;
  emojiText: Phaser.GameObjects.Text;
  followUpdate: () => void;
  destroy: () => void;
}

export class WorldScene extends Phaser.Scene {
  private npcs = new Map<string, Entity & { def: NpcDef; tween?: Phaser.Tweens.Tween }>();

  // npc auto-walk state — one path per NPC
  private npcPaths = new Map<string, { col: number; row: number }[]>();

  // visualizer store
  private unsubscribeAgents: (() => void) | null = null;

  // dialog/interaction store
  private unsubscribeGame: (() => void) | null = null;
  private unsubDialogActive: (() => void) | null = null;

  // current zone (always interior now)
  private zone!: ZoneDef;

  // Free-pan camera state (v2.0). `dragStart` captures the pointer + scroll
  // position at mousedown; `isDragging` flips true once the pointer moves
  // past DRAG_THRESHOLD_PX so we can distinguish a drag from a click.
  private dragStart: {
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
  } | null = null;
  private isDragging = false;
  // Which NPC (if any) was under the pointer at mousedown time. Becomes the
  // click target at mouseup if no drag happened.
  private pointerDownNpcId: string | null = null;
  // Throttle for follow-mode camera pan so we don't restart the tween each frame.
  private lastFollowPanAt = 0;
  // True once the user has panned/zoomed. Used to decide whether panel
  // resizes should re-center the map (only before they've interacted).
  private hasUserMovedCamera = false;
  // Map size in world pixels; cached at create() so the wheel-zoom
  // handler can compute the cover-fit floor without re-reading zone.
  private mapPixelW = 0;
  private mapPixelH = 0;

  // Debug overlay — red rects around every Tiled object + green dots at
  // each NPC's tile-anchor cell. Toggle with the `D` key. Persisted on
  // window so a refreshed scene picks up the previous setting.
  private debugGfx?: Phaser.GameObjects.Graphics;
  private debugVisible = false;
  // Cache of objects from the .tmj — used by the debug overlay so we
  // don't have to re-fetch the parsed map each frame.
  private debugObjects: Array<{
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    collidable: boolean;
    seat: boolean;
  }> = [];

  // Graphics object used to draw tether lines between parent NPCs and their
  // sub-agent children. Redrawn every frame inside `update()`.
  private tetherGfx!: Phaser.GameObjects.Graphics;

  // Cinema loop — idle NPCs head to the Cinema and sit on a seat.
  // Replaced the old wanderTick (which moved NPCs to random rooms for no
  // reason). NPCs now only move for real activity OR to/from the cinema.
  private idleSitTimer: Phaser.Time.TimerEvent | null = null;
  // Last time an NPC did something real (tool activity or summon). Used to
  // gate the cinema loop — we only send them to the cinema after a quiet
  // window, so we don't yank a just-walked NPC back.
  private lastActivityAt = new Map<string, number>();
  // Claimed cinema seats: npcId -> seat key. A seat key is "col,row".
  private occupiedSeats = new Map<string, string>();
  // Inverse lookup so we can release a seat without scanning.
  private seatByNpc = new Map<string, SeatCell>();
  // Pixel-precise final position for an in-progress walkNpcToCell.
  // Used to land sprites on the seat's authored center instead of
  // the tile center on the LAST step of the path. Cleared on arrival.
  private npcSeatOffset = new Map<string, { px: number; py: number }>();
  // Counter-state for each summon tick so we only act on increments.
  private lastSeenSummonTicks: Record<string, number> = {};

  constructor() {
    super("WorldScene");
  }

  preload() {
    // Limezu "Modern Office Revamped" character sheets (CC0). Four
    // distinct characters (Adam, Alex, Amelia, Bob); we hash agent id
    // → character so each session looks consistent and multiple
    // agents look different. Each sheet is 384×32 = 24 frames of 16×16
    // (run cycle, 6 per direction). The walk anim uses two of those.
    for (const c of MODERN_CHARS) {
      // Run sheet — used for walk anims while the NPC is mid-path.
      this.load.spritesheet(
        MODERN_KEY(c),
        `/assets/sprites/modern/${c}_run_16x16.png`,
        // Sheet is 384×32 = 24 frames at 16w × 32h. The character is
        // two tiles tall (head + body) — using frameHeight 16 would
        // crop to just the head.
        { frameWidth: 16, frameHeight: 32 },
      );
      // Idle-anim sheet — used as the resting loop so agents look alive
      // even when standing still (not seated).
      this.load.spritesheet(
        MODERN_IDLE_KEY(c),
        `/assets/sprites/modern/${c}_idle_anim_16x16.png`,
        { frameWidth: 16, frameHeight: 32 },
      );
      // Sit sheet — `*_sit3_16x16.png` is the front-facing seated
      // variant (eyes toward the camera) so a player can see who's at
      // the desk. The other sit*_16x16 sheets show the character from
      // behind / from the side and read as "agent has turned away".
      this.load.spritesheet(
        MODERN_SIT_KEY(c),
        `/assets/sprites/modern/${c}_sit3_16x16.png`,
        { frameWidth: 16, frameHeight: 32 },
      );
    }
  }

  /** Pick a Modern character for this NPC by id hash so the same agent
   *  always renders as the same person, but two simultaneous agents
   *  almost always look different. The hash also folds in the agent's
   *  provider id so two providers with the same agent id (rare but
   *  possible during a Cursor + Claude bridge) still draw distinct
   *  silhouettes. */
  private characterForNpc(id: string): ModernChar {
    const dyn = useNpcStore.getState().dynamic[id];
    const provider = dyn?.provider ?? "claude";
    const seed = `${provider}:${id}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    }
    return MODERN_CHARS[Math.abs(h) % MODERN_CHARS.length];
  }

  /** Returns the Phaser texture key the NPC should sample frames from.
   *  All four Modern sheets are preloaded once; per-NPC textures are no
   *  longer synthesized. The animKey for this NPC is keyed off the
   *  shared sheet so multiple agents that share a character still get
   *  smooth playback (Phaser anims are global by key). */
  private sheetKeyForNpc(id: string): string {
    return MODERN_KEY(this.characterForNpc(id));
  }

  private idleKeyForNpc(id: string): string {
    return MODERN_IDLE_KEY(this.characterForNpc(id));
  }

  private sitKeyForNpc(id: string): string {
    return MODERN_SIT_KEY(this.characterForNpc(id));
  }

  /** Play the per-character idle loop in the NPC's current facing.
   *  Used at the end of a walk path and after the spawn pop so the
   *  agent reads as alive rather than statue-still. Active choreos
   *  (typing/reading/etc) overwrite the frame manually each tick, so
   *  this never fights tool poses. */
  private playIdleAnim(npc: Entity) {
    if (!npc.sprite || !npc.sprite.scene) return;
    const animKey = `${npc.idleAnimKey}-idle-${npc.facing}`;
    if (!this.anims.exists(animKey)) return;
    npc.sprite.play(animKey, true);
  }

  /** Per-agent tint — deterministic from id so the same agent keeps
   *  the same look across reconnects. Combined with the 4 base
   *  characters this gives ~32 distinguishable silhouettes. */
  private tintForNpc(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = ((h * 31 + id.charCodeAt(i)) | 0);
    }
    return AGENT_TINTS[Math.abs(h) % AGENT_TINTS.length];
  }

  private ensureNpcTexture(npc: NpcDef) {
    // No-op: textures are loaded in preload(). Kept as a hook in case
    // a future design re-introduces per-agent texture synthesis.
    void npc;
  }

  async create() {
    // Stop the canvas from ever showing the browser's native right-click
    // menu. We handle right-click entirely in React (see GameCanvasInner).
    this.input.mouse?.disableContextMenu();
    // Clear color matches the page chrome (`bg-page` in globals.css) so
    // any letterbox / pillarbox bands blend with the app frame instead
    // of flashing pastel green.
    this.cameras.main.setBackgroundColor("#271d2e");
    this.cameras.main.roundPixels = true;

    // Async-load the Tiled `.tmj`, queue its tileset PNGs into Phaser's
    // loader, kick off a second load pass, then render once everything
    // is in memory. Phaser supports nested loads as long as we wait on
    // the LOADER_COMPLETE event.
    const bundle = await loadInteriorZone();
    this.zone = bundle.zone;
    // Cache the authored seat cells so claimFreeSeat / tickIdleSit / the
    // post-spawn flow can look them up without re-reading the manifest.
    this.seatCells = bundle.parsed.seatCells.slice();
    // Snapshot the raw Tiled objects so the debug overlay can outline
    // every authored rect (rooms, seats, decor, collision) without
    // re-fetching the .tmj.
    this.debugObjects = bundle.parsed.objects.map((o) => ({
      name: o.name,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      collidable: o.collidable,
      seat: o.seat,
    }));
    if (this.seatCells.length === 0 && typeof window !== "undefined") {
      console.warn(
        `[world] no seat objects in the .tmj — agents won't claim a desk after spawn.`,
      );
    }

    // Queue the tileset PNGs as Phaser spritesheets. Each tileset uses
    // its own grid dimensions (the Tiled file says 32x32 globally; this
    // matches our TILE_SIZE).
    for (const ts of this.zone.tilesets) {
      if (this.textures.exists(ts.key)) continue;
      this.load.spritesheet(ts.key, ts.imageUrl, {
        frameWidth: ts.tileWidth,
        frameHeight: ts.tileHeight,
      });
    }
    if (this.load.list.size > 0) {
      await new Promise<void>((resolve) => {
        this.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
        this.load.start();
      });
    }

    // Camera bounds = the map exactly. No pad → the user can't scroll
    // out of the painted area, so the chrome-colored clear never shows
    // through the play area. Phaser's centering math (centerOn) still
    // works inside these bounds.
    const mapW = this.zone.cols * TILE_SIZE;
    const mapH = this.zone.rows * TILE_SIZE;
    this.mapPixelW = mapW;
    this.mapPixelH = mapH;
    this.cameras.main.setBounds(0, 0, mapW, mapH);

    for (const npc of useNpcStore.getState().staticNpcs) {
      this.ensureNpcTexture(npc);
    }

    this.drawMap();
    this.drawRoomLabels();
    this.createAnims();
    this.createNpcs();
    this.setupMouseInput();
    this.subscribeStores();
    this.startIdleSitLoop();

    // Tether rendering layer — sits under sprites so it doesn't obscure them.
    this.tetherGfx = this.add.graphics().setDepth(950);

    // Debug overlay — drawn ABOVE everything so the inspector outlines
    // are unmistakable. Hidden by default; toggled by the `D` key.
    this.debugGfx = this.add.graphics().setDepth(2000).setVisible(false);
    this.input.keyboard?.on("keydown-D", (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      this.debugVisible = !this.debugVisible;
      this.debugGfx?.setVisible(this.debugVisible);
    });

    // Center + fit the map to the current viewport. We use the LARGER
    // of width-fit / height-fit ratios so the map COVERS the canvas
    // (no chrome bleed-through) — accepts a small crop on whichever
    // axis is more constrained. When the user scroll-zooms, this stops
    // auto-fitting and respects their viewing choice.
    const cam = this.cameras.main;
    const fitZoom = () => {
      // Always re-sync the camera viewport to the renderer size — with
      // `scale.mode: NONE` the camera doesn't auto-resize when the
      // canvas does, so without this the visible play area stays
      // pinned to the original 704×384 default and the rest of the
      // panel renders as empty chrome.
      cam.setSize(this.scale.width, this.scale.height);
      if (this.hasUserMovedCamera) return;
      // Snap to the next integer ≥ the cover-fit ratio. Integer zoom
      // keeps pixel art crisp; CEIL guarantees the map COVERS the
      // viewport (no chrome bands). We floor at 2 so that even when
      // the panel is small enough that zoom=1 would technically fit,
      // the world (and agents) still render at a visible size — at
      // zoom=1 on Retina, a 16-px sprite is only 8 CSS px tall.
      const fit = Math.max(cam.width / mapW, cam.height / mapH);
      const zoom = Math.max(2, Math.ceil(fit));
      cam.setZoom(zoom);
      cam.centerOn(mapW / 2, mapH / 2);
    };
    fitZoom();
    this.scale.on("resize", fitZoom);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", fitZoom);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribeAgents?.();
      this.unsubscribeGame?.();
      this.unsubDialogActive?.();
      this.unsubscribeAgents = null;
      this.unsubscribeGame = null;
      this.idleSitTimer?.destroy();
      this.idleSitTimer = null;
      // Clear all scene-local state. scene.restart() reuses the same
      // instance so class-field maps persist across restarts — an old
      // walk path targeting a now-destroyed sprite crashes tickNpcPaths.
      this.npcPaths.clear();
      this.npcs.clear();
      this.occupiedSeats.clear();
      this.seatByNpc.clear();
      this.npcSeatOffset.clear();
      this.lastActivityAt.clear();
    });
  }

  // --------------------------------------------------------------------
  // Cinema loop — idle NPCs head down to the Cinema room and sit on a seat
  // until summoned or until a real activity arrives. Replaces the old
  // random-wander loop so NPCs only move for a concrete reason.
  // --------------------------------------------------------------------

  // Live list of seat cells, populated from `parsed.seatCells` (objects
  // with `seat: true` in the .tmj). Set in create() once the map loads;
  // empty until then so claimFreeSeat is a no-op pre-load. The 60s-idle
  // cinema loop and the post-spawn assignment both walk this list.
  private seatCells: SeatCell[] = [];

  private startIdleSitLoop() {
    if (this.zone.id !== "interior") return;
    this.idleSitTimer = this.time.addEvent({
      delay: 2000,
      loop: true,
      callback: () => this.tickIdleSit(),
    });
  }

  private tickIdleSit() {
    if (useGameStore.getState().dialog.active) return;
    const now = this.time.now;
    // An NPC is "idle" if it hasn't had a real activity / summon / dialog
    // interaction in the last minute. After that it heads to the cinema to
    // chill until the player calls it again.
    const IDLE_MS = 60_000;

    for (const npc of this.npcs.values()) {
      // Already mid-path? Leave them alone.
      if (this.npcPaths.has(npc.def.id)) continue;
      // Already seated?
      if (this.seatByNpc.has(npc.def.id)) continue;
      // Not idle long enough yet.
      const last = this.lastActivityAt.get(npc.def.id) ?? 0;
      if (last !== 0 && now - last < IDLE_MS) continue;
      // Sub-agents follow their parent; don't drag them to the cinema.
      if ((npc.def as { parentId?: string }).parentId) continue;

      const seat = this.claimFreeSeat(npc.def.id);
      if (!seat) continue;

      this.walkNpcToCell(npc.def.id, seat.col, seat.row, {
        px: seat.px,
        py: seat.py,
      });
      // Record an activity timestamp at the cinema-departure moment so the
      // loop doesn't immediately re-fire for the next NPC on the same tick
      // that happens to land on the same quiet threshold.
      if (!this.lastActivityAt.has(npc.def.id)) {
        this.lastActivityAt.set(npc.def.id, now);
      }
    }
  }

  private claimFreeSeat(npcId: string): SeatCell | null {
    for (const seat of this.seatCells) {
      const key = `${seat.col},${seat.row}`;
      if (this.occupiedSeats.has(key)) continue;
      this.occupiedSeats.set(key, npcId);
      this.seatByNpc.set(npcId, seat);
      return seat;
    }
    return null;
  }

  private releaseSeat(npcId: string) {
    const seat = this.seatByNpc.get(npcId);
    if (!seat) return;
    this.seatByNpc.delete(npcId);
    this.occupiedSeats.delete(`${seat.col},${seat.row}`);
    // Restore the standing texture so the next walk anim plays from
    // the run sheet rather than the seated one.
    const npc = this.npcs.get(npcId);
    if (npc?.sprite?.scene && npc.sprite.texture.key !== npc.animKey) {
      try {
        npc.sprite.setTexture(npc.animKey, FRAME[npc.facing][0]);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Hit-test: given a point in camera-view pixel space (native, pre-CSS
   * zoom), return the NPC id whose sprite covers that point, or null.
   * Used by GameCanvasInner to resolve right-clicks to NPCs.
   *
   * Must account for `cam.zoom` — v2.0 gave the camera runtime zoom, so a
   * pixel in viewX is no longer 1:1 with world pixels. Divide by zoom
   * before translating to world space.
   */
  npcAtViewPoint(viewX: number, viewY: number): string | null {
    const cam = this.cameras.main;
    const world = cam.getWorldPoint(viewX, viewY);
    // NPC sprites use origin (0.5, 1) — so sprite.y is the sprite's bottom.
    // The visible center sits at (sprite.x, sprite.y - TILE_SIZE/2).
    // Grow the hit box as zoom decreases so small on-screen sprites remain clickable.
    const HIT = Math.max(TILE_SIZE / 2, (TILE_SIZE / 2) / cam.zoom);
    for (const [id, npc] of this.npcs) {
      const cx = npc.sprite.x;
      const cy = npc.sprite.y - TILE_SIZE / 2;
      if (Math.abs(cx - world.x) <= HIT && Math.abs(cy - world.y) <= HIT) {
        return id;
      }
    }
    return null;
  }

  /**
   * Public summon entrypoint — walks an NPC to "center stage" (Ops Center
   * anchor). Called from roster clicks and the context-menu "Call here" item
   * to draw attention to a specific agent in the observatory. The camera
   * does not move — use follow mode for that.
   */
  summonNpc(id: string) {
    const npc = this.npcs.get(id);
    if (!npc) return;

    this.releaseSeat(id);
    this.lastActivityAt.set(id, this.time.now);

    // Walk to a tile near the Ops Center anchor (center of the floor).
    const anchor = ROOM_ANCHORS.desk;
    const candidates: Array<[number, number]> = [
      [anchor.col, anchor.row],
      [anchor.col + 1, anchor.row],
      [anchor.col - 1, anchor.row],
      [anchor.col, anchor.row + 1],
      [anchor.col, anchor.row - 1],
    ];
    let target: { col: number; row: number } | null = null;
    for (const [c, r] of candidates) {
      if (this.isWalkableHere(c, r) && !this.isEntityAt(c, r, id)) {
        target = { col: c, row: r };
        break;
      }
    }
    if (!target) return;
    this.walkNpcToCell(id, target.col, target.row);
  }

  /**
   * Like walkNpcToRoom but targets an arbitrary cell. Used by the cinema
   * loop (targets seats) and by summonNpc (targets tiles near the player).
   *
   * If `finalOffset` is supplied, the LAST step of the path lands on
   * the offset's pixel center instead of the tile center — used so
   * sprites rest on the actual chair art rather than near it.
   */
  private walkNpcToCell(
    npcId: string,
    targetCol: number,
    targetRow: number,
    finalOffset?: { px: number; py: number },
  ) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;

    const blocked: Array<{ col: number; row: number }> = [];
    for (const other of this.npcs.values()) {
      if (other.def.id === npcId) continue;
      blocked.push({ col: other.col, row: other.row });
    }
    const path = bfs(npc.col, npc.row, targetCol, targetRow, { blocked });
    if (path.length <= 1) {
      // Already there. Apply offset directly so a re-claim of the same
      // tile still snaps the sprite onto the chair.
      if (finalOffset) {
        npc.sprite.setPosition(finalOffset.px, finalOffset.py);
        npc.shadow.setPosition(finalOffset.px, finalOffset.py + 7);
        npc.facing = "down";
        try {
          npc.sprite.stop();
          npc.sprite.setFrame(FRAME.down[0]);
        } catch {
          // ignore
        }
      }
      return;
    }
    this.npcPaths.set(npcId, path.slice(1));
    if (finalOffset) {
      this.npcSeatOffset.set(npcId, finalOffset);
    } else {
      this.npcSeatOffset.delete(npcId);
    }
  }

  // --------------------------------------------------------------------
  // map rendering
  // --------------------------------------------------------------------
  private drawMap() {
    const { gids, cols, rows, tilesets } = this.zone;
    // Single tile layer: walk row-major, decode each gid → (tileset key,
    // frame), draw at depth 0. Empty cells (gid 0) skip — Phaser's clear
    // background handles those.
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const gid = gids[row * cols + col];
        if (!gid) continue;
        const resolved = resolveGid(gid, tilesets);
        if (!resolved) continue;
        this.add
          .image(col * TILE_SIZE, row * TILE_SIZE, resolved.key, resolved.frame)
          .setOrigin(0, 0)
          .setDepth(0);
      }
    }
  }

  private isWalkableHere(col: number, row: number): boolean {
    return isWalkableIn(this.zone, col, row);
  }

  // Empty-state hints — one Phaser Text per room, painted at the room's
  // anchor cell. Only drawn while no dynamic NPC is present so they
  // don't compete with sprites once activity starts. Built once at
  // create() and shown/hidden in tickEmptyStateHints().
  private emptyStateLabels: Phaser.GameObjects.Text[] = [];

  private drawRoomLabels() {
    // Build the empty-state labels. They start hidden; the per-frame
    // tickEmptyStateHints toggles visibility based on dynamic-NPC count.
    if (this.emptyStateLabels.length > 0) {
      for (const t of this.emptyStateLabels) t.destroy();
      this.emptyStateLabels = [];
    }
    const regions = getRoomRegions();
    for (const r of regions) {
      const room = roomById(r.id);
      if (!room) continue;
      const cx = ((r.colMin + r.colMax + 1) / 2) * TILE_SIZE;
      const cy = ((r.rowMin + r.rowMax + 1) / 2) * TILE_SIZE;
      const t = this.add
        .text(cx, cy, room.label.toUpperCase(), {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: "9px",
          color: "#6ee7b7",
          backgroundColor: "#0e1018",
          padding: { x: 6, y: 3 },
          resolution: 3,
        })
        .setOrigin(0.5, 0.5)
        .setDepth(800)
        .setAlpha(0);
      this.emptyStateLabels.push(t);
    }
  }

  /** Fade the empty-state room labels in/out based on whether any
   *  dynamic agent is present. Cheap — runs each frame but only writes
   *  alpha when it actually changes. */
  private tickEmptyStateHints() {
    if (this.emptyStateLabels.length === 0) return;
    const dyn = useNpcStore.getState().dynamic;
    const hasAgents = Object.keys(dyn).length > 0;
    const targetAlpha = hasAgents ? 0 : 0.85;
    for (const t of this.emptyStateLabels) {
      if (Math.abs(t.alpha - targetAlpha) < 0.02) continue;
      // Smooth fade over a few frames — avoids the "popping" that an
      // instant-set produces when an agent walks in.
      const next = t.alpha + (targetAlpha - t.alpha) * 0.15;
      t.setAlpha(next);
    }
  }

  // --------------------------------------------------------------------
  // animation setup — anim keys are scoped to the SHARED sheet, not the
  // individual NPC, so multiple agents on the same character reuse the
  // same global Phaser animation.
  // --------------------------------------------------------------------
  private createAnims() {
    for (const c of MODERN_CHARS) {
      this.ensureAnimsForSheet(MODERN_KEY(c));
      this.ensureIdleAnimsForSheet(MODERN_IDLE_KEY(c));
    }
  }

  private ensureAnimsForSheet(sheetKey: string) {
    for (const dir of ["down", "up", "left", "right"] as Direction[]) {
      const frames = FRAME[dir];
      const animKey = `${sheetKey}-walk-${dir}`;
      if (this.anims.exists(animKey)) continue;
      this.anims.create({
        key: animKey,
        frames: [
          { key: sheetKey, frame: frames[0] },
          { key: sheetKey, frame: frames[1] },
        ],
        frameRate: 7,
        repeat: -1,
      });
    }
  }

  /** Idle-loop animations — one per direction. Slow frame rate so the
   *  bob/blink reads as resting rather than fidgeting. */
  private ensureIdleAnimsForSheet(idleKey: string) {
    for (const dir of ["down", "up", "left", "right"] as Direction[]) {
      const frames = IDLE_FRAME[dir];
      const animKey = `${idleKey}-idle-${dir}`;
      if (this.anims.exists(animKey)) continue;
      this.anims.create({
        key: animKey,
        frames: frames.map((f) => ({ key: idleKey, frame: f })),
        frameRate: 4,
        repeat: -1,
      });
    }
  }

  // --------------------------------------------------------------------
  // entity creation
  // --------------------------------------------------------------------
  private createNpcs() {
    for (const def of useNpcStore.getState().staticNpcs) {
      this.addNpcEntity(def);
    }
    // Re-materialize any already-present dynamic NPCs from the store.
    for (const dyn of Object.values(useNpcStore.getState().dynamic)) {
      this.addNpcEntity(dyn);
    }
  }

  addNpcEntity(def: NpcDef) {
    if (this.npcs.has(def.id)) return;
    this.ensureNpcTexture(def);

    // Spawn position. CP6: dynamic (non-static, non-sub-agent) NPCs enter
    // the scene from the exterior path — SessionStart feels like an
    // arrival. Sub-agents spawn next to their parent. Static NPCs (if any)
    // spawn at their home anchor.
    let col = def.col;
    let row = def.row;
    let targetCol = def.col;
    let targetRow = def.row;
    const isDynamic = Boolean(
      (def as { dynamic?: boolean }).dynamic,
    );
    const parentId =
      (def as { parentId?: string }).parentId ?? undefined;
    if (isDynamic && !parentId) {
      // Walk-in: start at the south entry, then queue a walk to the
      // originally-requested room anchor.
      col = EXTERIOR_ANCHORS.entry.col;
      row = EXTERIOR_ANCHORS.entry.row;
    }
    if (parentId) {
      const parent = this.npcs.get(parentId);
      if (parent) {
        // Pick a free neighbour of the parent.
        const spots: Array<[number, number]> = [
          [parent.col + 1, parent.row],
          [parent.col - 1, parent.row],
          [parent.col, parent.row + 1],
          [parent.col, parent.row - 1],
          [parent.col + 1, parent.row + 1],
          [parent.col - 1, parent.row - 1],
        ];
        for (const [c, r] of spots) {
          if (this.isWalkableHere(c, r) && !this.isEntityAt(c, r)) {
            col = c;
            row = r;
            break;
          }
        }
      }
    }

    // Pick a free adjacent tile if the slot is still taken
    if (!this.isWalkableHere(col, row) || this.isEntityAt(col, row)) {
      const candidates: Array<[number, number]> = [
        [col, row],
        [col + 1, row],
        [col - 1, row],
        [col, row + 1],
        [col, row - 1],
        [col + 2, row],
        [col, row + 2],
      ];
      for (const [c, r] of candidates) {
        if (this.isWalkableHere(c, r) && !this.isEntityAt(c, r)) {
          col = c;
          row = r;
          break;
        }
      }
    }

    const px = col * TILE_SIZE + TILE_SIZE / 2;
    const py = row * TILE_SIZE + TILE_SIZE / 2;
    const shadow = this.add
      .rectangle(px, py + 7, 10, 3, 0x0f380f, 0.35)
      .setDepth(900);
    const sheetKey = this.sheetKeyForNpc(def.id);
    const idleAnimKey = this.idleKeyForNpc(def.id);
    const sitSheetKey = this.sitKeyForNpc(def.id);
    this.ensureAnimsForSheet(sheetKey);
    this.ensureIdleAnimsForSheet(idleAnimKey);
    const sprite = this.add
      .sprite(px, py, sheetKey, FRAME.down[0])
      .setDepth(1000 + row);
    // Per-agent tint so two NPCs sharing a base character still look
    // distinct. White (0xffffff) is a no-op tint and preserves the
    // authored colors.
    const tint = this.tintForNpc(def.id);
    if (tint !== 0xffffff) sprite.setTint(tint);
    sprite.setInteractive({ useHandCursor: true, pixelPerfect: false });
    sprite.on("pointerover", () => {
      if (useGameStore.getState().dialog.active) return;
      const ent = this.npcs.get(def.id);
      if (ent) {
        ent.pillHover = true;
        this.renderPill(def.id);
      }
      this.tweens.add({
        targets: sprite,
        scaleX: sprite.scaleX * 1.08,
        scaleY: sprite.scaleY * 1.08,
        duration: 120,
        ease: "Quad.easeOut",
      });
    });
    sprite.on("pointerout", () => {
      // Look up the resting scale for this NPC and tween back to it.
      const ent = this.npcs.get(def.id);
      const target = ent?.restingScale ?? 1;
      if (ent) {
        ent.pillHover = false;
        this.renderPill(def.id);
      }
      this.tweens.add({
        targets: sprite,
        scaleX: target,
        scaleY: target,
        duration: 120,
        ease: "Quad.easeOut",
      });
    });

    const indicator = this.add
      .text(px, py - 14, "!", {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: "11px",
        color: "#0f380f",
        resolution: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(1500 + row)
      .setAlpha(0);

    // Always-on overhead pill. Two Text objects (code + emoji) laid out
    // side-by-side inside a shared rounded-rect background. Emoji uses a
    // system font stack so platform color emoji renders natively.
    const overheadBg = this.add.graphics();
    const overheadCodeText = this.add
      .text(0, 0, pillLabelFor(def as { id: string; name?: string; cwd?: string }), {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: "10px",
        color: "#1b1e2b",
        resolution: 3,
      })
      .setOrigin(0, 0.5);
    const overheadEmojiText = this.add
      .text(0, 0, IDLE_EMOJI, {
        fontFamily:
          '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
        fontSize: "14px",
        color: "#1b1e2b",
        resolution: 3,
      })
      .setOrigin(0, 0.5);
    const overheadContainer = this.add
      .container(px, py - 22, [overheadBg, overheadCodeText, overheadEmojiText])
      .setDepth(1600 + row)
      .setAlpha(1);

    // Sub-agents (those with a parentId) render at 80% scale so they read
    // as visibly subordinate to their parent NPC. The spawn pop starts from
    // that reduced target scale rather than 1.
    const isSubAgent = Boolean(
      (def as { parentId?: string }).parentId,
    );
    // World tiles are 32px. Limezu Modern sprites are 16w × 32h native
    // — already as tall as a tile. Scale 1 keeps the figure fitting in
    // a single cell vertically; sub-agents render at 0.85 to read as
    // visibly smaller.
    const restingScale = isSubAgent ? 0.85 : 1;

    // Floating "HELPER" badge above sub-agents. Reads like a chip on
    // the parent's tether, so the relationship is obvious without the
    // user having to spot the dotted line.
    let helperBadge: Phaser.GameObjects.Text | undefined;
    if (isSubAgent) {
      helperBadge = this.add
        .text(px, py - TILE_SIZE - 10, "HELPER", {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: "7px",
          color: "#22c55e",
          resolution: 3,
        })
        .setOrigin(0.5, 1)
        .setDepth(1599 + row)
        .setAlpha(0.9);
    }

    this.npcs.set(def.id, {
      def,
      sprite,
      shadow,
      indicator,
      overheadBg,
      overheadCodeText,
      overheadEmojiText,
      overheadContainer,
      overheadBaselineEmoji: IDLE_EMOJI,
      col,
      row,
      facing: "down",
      animKey: sheetKey,
      idleAnimKey,
      sitSheetKey,
      restingScale,
      helperBadge,
    });

    // Paint the initial pill (resting state, idle emoji). We do this once
    // the entry is in the map so renderPill can reach it by id.
    this.renderPill(def.id);

    // Gentle spawn pop
    sprite.setScale(restingScale * 0.5);
    this.tweens.add({
      targets: sprite,
      scale: restingScale,
      duration: 220,
      ease: "Back.easeOut",
      onComplete: () => {
        // Once the NPC settles, start an idle-bob so it's never totally still.
        // For sub-agents we encode the resting scale so the choreo's scale
        // resets (`setScale(1,1)` on stop) don't override it — choreo.stop
        // is fine because restingScale is reapplied here on completion.
        const entity = this.npcs.get(def.id);
        if (!entity) return;
        entity.sprite.setScale(restingScale);
        this.startChoreoFor(entity, "idle-bob");
        this.playIdleAnim(entity);
      },
    });

    // Decide where this NPC is going. If there's a pending TOOL event
    // (Read/Edit/Bash/etc) we route to that tool's room. Otherwise —
    // including when the only event is a session-start — we claim a
    // free Desk Seat and walk there. Without this, every dynamic NPC
    // would walk to the SAME room anchor on session start, which
    // looked like "two agents at one desk".
    const pending = useAgentStore.getState().activities[def.id];
    const pendingTool =
      (pending?.event.metadata as { toolName?: string } | undefined)?.toolName;
    const dynamicTopLevel = isDynamic && !parentId;

    if (pending && pendingTool) {
      // Real tool in flight — route to its room.
      this.lastActivityAt.set(def.id, this.time.now);
      this.walkNpcToRoom(def.id, pending.room);
      const pathLen = this.npcPaths.get(def.id)?.length ?? 0;
      this.time.delayedCall(pathLen * STEP_DURATION_MS + 40, () => {
        const live = this.npcs.get(def.id);
        if (!live) return;
        this.startChoreoFor(live, pending.choreo);
        this.updateOverheadPill(
          def.id,
          pendingTool,
          pending.event.state,
          false,
        );
      });
    } else if (dynamicTopLevel) {
      // No real tool yet — claim a free seat and walk there. Sub-
      // agents and static NPCs fall through to the default home cell.
      const seat = this.claimFreeSeat(def.id);
      if (seat) {
        this.walkNpcToCell(def.id, seat.col, seat.row, {
          px: seat.px,
          py: seat.py,
        });
      } else if (typeof window !== "undefined") {
        console.warn(
          `[world] no free seat for ${def.id} — ${this.occupiedSeats.size}/${this.seatCells.length} seats taken. Falling back to spawn cell.`,
        );
        this.walkNpcToCell(def.id, targetCol, targetRow);
      } else {
        this.walkNpcToCell(def.id, targetCol, targetRow);
      }
    } else if (pending) {
      // Pending but no tool (session start, thinking, etc) — leave the
      // NPC at its spawn cell; the subscribeStores activity feed will
      // route them on the next real event.
      this.startChoreoFor(this.npcs.get(def.id)!, pending.choreo);
    }
  }

  removeNpcEntity(id: string) {
    const npc = this.npcs.get(id);
    if (!npc) return;

    // Master-hive guard: a sub-agent under a `claude-master` parent
    // outlives any single Task tool_use. Skip removal as long as the
    // parent is still in the scene; the master-hive provider issues
    // its own explicit removal when the team disperses.
    const parentId = (npc.def as { parentId?: string }).parentId;
    if (parentId) {
      const parent = useNpcStore.getState().dynamic[parentId];
      if (parent?.provider === "claude-master") {
        return;
      }
    }

    // Tear down any active choreo + helper first so their tweens/timers
    // don't operate on a destroyed sprite.
    this.stopChoreoFor(npc);
    this.despawnHelper(npc);

    this.tweens.killTweensOf(npc.sprite);
    this.tweens.killTweensOf(npc.shadow);
    if (npc.overheadContainer) this.tweens.killTweensOf(npc.overheadContainer);
    if (npc.indicator) this.tweens.killTweensOf(npc.indicator);

    // Walk-out: dynamic top-level agents (not sub-agents) walk to the
    // exterior exit before fading. Everything else fades in place.
    const isDynamic = Boolean(
      (npc.def as { dynamic?: boolean }).dynamic,
    );
    const hasParent = Boolean((npc.def as { parentId?: string }).parentId);
    const shouldWalkOut = isDynamic && !hasParent;

    const fadeAndDestroy = () => {
      // Re-fetch in case the NPC was already torn down.
      if (!npc.sprite.scene) return;
      this.tweens.add({
        targets: npc.sprite,
        alpha: 0,
        scale: 0.5,
        duration: 200,
        ease: "Back.easeIn",
        onComplete: () => {
          npc.sprite.destroy();
          npc.shadow.destroy();
          npc.indicator?.destroy();
          npc.overheadContainer?.destroy();
          npc.helperBadge?.destroy();
          npc.thinkingBadge?.container.destroy();
          npc.thinkingBadge?.maskGfx.destroy();
          npc.transitBadge?.destroy();
        },
      });
      if (npc.overheadContainer) {
        this.tweens.add({
          targets: npc.overheadContainer,
          alpha: 0,
          duration: 200,
          ease: "Linear",
        });
      }
    };

    // Detach from npcs immediately so `update()` stops pinning the pill and
    // tick loops stop treating this as an active agent. The sprite stays
    // until the walk-out completes (we hold `npc` in closure).
    this.npcs.delete(id);
    this.npcPaths.delete(id);
    this.npcSeatOffset.delete(id);

    if (shouldWalkOut) {
      // Drive the walk manually via two parallel tweens — the sprite and
      // its shadow each tween toward the same world cell (shadow sits 7px
      // below the sprite). We tween linearly because the BFS-based walker
      // has already been detached from this entity.
      const { entry: entryCell } = EXTERIOR_ANCHORS;
      const targetX = entryCell.col * TILE_SIZE + TILE_SIZE / 2;
      const targetY = entryCell.row * TILE_SIZE + TILE_SIZE / 2;
      const dist = Math.hypot(targetX - npc.sprite.x, targetY - npc.sprite.y);
      const walkMs = Math.min(2000, Math.max(400, dist * 4));
      this.tweens.add({
        targets: npc.sprite,
        x: targetX,
        y: targetY,
        duration: walkMs,
        ease: "Linear",
        onComplete: fadeAndDestroy,
      });
      this.tweens.add({
        targets: npc.shadow,
        x: targetX,
        y: targetY + 7,
        duration: walkMs,
        ease: "Linear",
      });
    } else {
      fadeAndDestroy();
    }
  }

  /**
   * Set the resting emoji for an NPC's overhead pill. Pass `toolName` from
   * the latest activity event (falls back to `state` → `stateToFace`, or
   * idle). The pill redraws immediately.
   *
   * If `isError` is true, flashes to ❌ for 800 ms; after the flash the pill
   * returns to the baseline emoji that was active when the error fired.
   */
  private updateOverheadPill(
    npcId: string,
    toolName: string | undefined,
    state: AgentEvent["state"] | undefined,
    isError: boolean,
  ) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    const resting = emojiForActivity(toolName, state);
    npc.overheadBaselineEmoji = resting;
    if (isError) {
      npc.overheadErrorUntil = this.time.now + 2000;
      // Red sprite tint for 2s — visible even when zoomed out so a
      // crashed agent is obvious without watching the pill.
      try {
        npc.sprite.setTint(0xef4444);
        this.time.delayedCall(2000, () => {
          if (npc.sprite && npc.sprite.scene) npc.sprite.clearTint();
        });
      } catch {
        // sprite torn down — ignore
      }
    }
    this.renderPill(npcId);
  }

  /**
   * Paint the current state of the pill (bg rect + text) based on what the
   * entity already carries. Called from updateOverheadPill and from
   * createNpc for the first draw; the per-frame update() decays the error
   * flash back to baseline.
   */
  private renderPill(npcId: string) {
    const npc = this.npcs.get(npcId);
    if (!npc || !npc.overheadContainer || !npc.overheadBg) return;
    const code = npc.overheadCodeText;
    const emoji = npc.overheadEmojiText;
    if (!code || !emoji) return;

    const now = this.time.now;
    const showError =
      npc.overheadErrorUntil !== undefined && now < npc.overheadErrorUntil;
    const showPrompt =
      npc.overheadPromptUntil !== undefined && now < npc.overheadPromptUntil;
    const activeEmoji = showError
      ? ERROR_EMOJI
      : showPrompt
        ? PROMPT_EMOJI
        : npc.overheadBaselineEmoji ?? IDLE_EMOJI;
    emoji.setText(activeEmoji);

    const bg = npc.overheadBg;
    bg.clear();

    // Compact mode (default): only the activity emoji is visible
    // above the agent. The name + chip background appear on hover.
    if (!npc.pillHover) {
      code.setVisible(false);
      emoji.setPosition(-emoji.width / 2, 0);
      return;
    }

    // Hover mode: full pill — [padding code · padding emoji padding]
    code.setVisible(true);
    const PAD_X = 6;
    const GAP = 5;
    const codeW = code.width;
    const emojiW = emoji.width;
    const innerW = codeW + GAP + emojiW;
    const w = innerW + PAD_X * 2;
    const h = Math.max(code.height, emoji.height) + 6;
    code.setPosition(-w / 2 + PAD_X, 0);
    emoji.setPosition(-w / 2 + PAD_X + codeW + GAP, 0);

    bg.fillStyle(0xffffff, 0.95);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 3);
    bg.lineStyle(1, 0x1b1e2b, 1);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 3);
  }

  // --------------------------------------------------------------------
  // mouse input — drag to pan, wheel to zoom, click NPC to open dialog
  // --------------------------------------------------------------------
  //
  // Coordinate systems in play:
  //   - Phaser's pointer (pointer.x/y) is in the game canvas' internal
  //     resolution (what we call "native" — matches g.scale.resize args).
  //   - cam.scrollX/Y is in WORLD pixels. One world pixel == one sprite
  //     pixel regardless of camera zoom.
  //   - To convert a native-pixel delta into a world-pixel delta you
  //     divide by cam.zoom.
  //
  // We accumulate deltas each move rather than recomputing from a
  // mousedown origin; that keeps the drag consistent even if the canvas
  // resizes mid-drag, and avoids snap-back if pointer events miss.
  private setupMouseInput() {
    const cam = this.cameras.main;

    this.input.on(
      "pointerdown",
      (pointer: Phaser.Input.Pointer) => {
        if (pointer.rightButtonDown()) return;
        if (useGameStore.getState().dialog.active) return;
        this.dragStart = {
          x: pointer.x,
          y: pointer.y,
          scrollX: cam.scrollX,
          scrollY: cam.scrollY,
        };
        this.isDragging = false;
        this.pointerDownNpcId = this.npcAtViewPoint(pointer.x, pointer.y);
      },
      this,
    );

    this.input.on(
      "pointermove",
      (pointer: Phaser.Input.Pointer) => {
        if (!this.dragStart || !pointer.isDown) return;
        // Use accumulated delta from the move event itself (pointer.x is
        // current; we already cached pointerdown's x/y in dragStart).
        const dx = pointer.x - this.dragStart.x;
        const dy = pointer.y - this.dragStart.y;
        if (
          !this.isDragging &&
          Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX
        ) {
          this.isDragging = true;
          this.hasUserMovedCamera = true;
          useGameStore.getState().setFollowNpc(null);
        }
        if (!this.isDragging) return;
        // Pan: newScroll = initialScroll - (screen delta / zoom).
        // setScroll clamps to cam.getBounds() automatically.
        cam.setScroll(
          this.dragStart.scrollX - dx / cam.zoom,
          this.dragStart.scrollY - dy / cam.zoom,
        );
      },
      this,
    );

    const endDrag = (pointer: Phaser.Input.Pointer) => {
      const wasDragging = this.isDragging;
      const downId = this.pointerDownNpcId;
      this.dragStart = null;
      this.isDragging = false;
      this.pointerDownNpcId = null;
      if (wasDragging) return;
      if (pointer.rightButtonReleased()) return;
      // Click with no drag → open the clicked NPC's dialog if still over.
      const upId = this.npcAtViewPoint(pointer.x, pointer.y);
      if (!downId || downId !== upId) return;
      this.openDialogForNpc(downId);
    };
    this.input.on("pointerup", endDrag, this);
    // pointerupoutside fires if the mouse is released outside the canvas
    // mid-drag — without this the drag state would never clear.
    this.input.on("pointerupoutside", endDrag, this);

    this.input.on(
      "wheel",
      (
        pointer: Phaser.Input.Pointer,
        _objects: unknown,
        _dx: number,
        dy: number,
      ) => {
        if (useGameStore.getState().dialog.active) return;
        if (dy === 0) return;
        this.hasUserMovedCamera = true;
        const oldZoom = cam.zoom;
        const step = Math.min(0.15, Math.abs(dy) * 0.0015);
        const direction = dy > 0 ? -1 : 1;
        // Lower bound: zoom out cannot go past the cover-fit ratio,
        // otherwise the map is smaller than the viewport and the user
        // sees chrome bands. Upper bound: hard cap at ZOOM_MAX.
        const minCover = this.mapPixelW
          ? Math.max(cam.width / this.mapPixelW, cam.height / this.mapPixelH)
          : ZOOM_MIN;
        const lo = Math.max(ZOOM_MIN, minCover);
        const nextZoom = Math.max(
          lo,
          Math.min(ZOOM_MAX, oldZoom * Math.exp(direction * step)),
        );
        if (Math.abs(nextZoom - oldZoom) < 0.0005) return;
        // Canonical zoom-to-cursor: sample the world point under the
        // pointer BEFORE and AFTER the zoom change, then shift scroll by
        // the delta. getWorldPoint already accounts for Phaser's 0.5,0.5
        // camera origin, rotation, and current scroll, so this stays
        // correct across panel resizes and bounds clamping.
        const before = cam.getWorldPoint(pointer.x, pointer.y);
        cam.setZoom(nextZoom);
        const after = cam.getWorldPoint(pointer.x, pointer.y);
        cam.scrollX -= after.x - before.x;
        cam.scrollY -= after.y - before.y;
      },
      this,
    );
  }

  private openDialogForNpc(id: string) {
    const npc = this.npcs.get(id);
    if (!npc) return;
    const activity = useAgentStore.getState().activities[id];
    const greeting = buildLiveGreeting(
      npc.def as unknown as {
        name: string;
        cwd?: string;
        greeting: string;
        parentId?: string;
      },
      activity,
    );
    useGameStore.getState().openDialog(npc.def, greeting);
  }

  // --------------------------------------------------------------------
  // store subscriptions
  // --------------------------------------------------------------------
  private subscribeStores() {
    this.unsubscribeAgents = useAgentStore.subscribe((state, prev) => {
      if (this.zone.id !== "interior") return;
      for (const [agentId, act] of Object.entries(state.activities)) {
        const prevAct = prev.activities[agentId];
        if (prevAct && prevAct.version === act.version) continue;
        const npc = this.npcs.get(agentId);
        if (!npc) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[WorldScene] activity for unknown NPC id=${agentId} — addNpcEntity will replay when it arrives.`,
            );
          }
          continue;
        }
        // Real activity — mark the NPC as "not idle" and free their cinema
        // seat so the cinema loop doesn't re-herd them.
        this.lastActivityAt.set(agentId, this.time.now);
        this.releaseSeat(agentId);
        this.walkNpcToRoom(agentId, act.room);
        const toolName = (act.event.metadata as { toolName?: string } | undefined)
          ?.toolName;
        const isError =
          act.event.type === "agent.tool.result" &&
          Boolean(
            (act.event.metadata as { isError?: boolean } | undefined)?.isError,
          );
        // UserPromptSubmit comes through as an `agent.thinking` event with
        // `fromUser: true`. Flash the 📨 indicator above the agent so it's
        // obvious the user just spoke, even if the rolling thinking
        // marquee hasn't redrawn yet.
        const fromUser = Boolean(
          (act.event.metadata as { fromUser?: boolean } | undefined)?.fromUser,
        );
        if (fromUser) {
          npc.overheadPromptUntil = this.time.now + 2400;
        }
        this.updateOverheadPill(agentId, toolName, act.event.state, isError);

        // The behavior registry (src/game/behaviors.ts) has already resolved
        // which room to walk to and which choreography to play. We only
        // handle two special cases here: Task spawn (needs a helper dwarf)
        // and task-result (despawn helper immediately).
        const behaviorId = act.behaviorId;
        if (behaviorId === "task-result") {
          this.despawnHelper(npc);
          this.startChoreoFor(npc, act.choreo);
          continue;
        }

        const pathLen = this.npcPaths.get(agentId)?.length ?? 0;
        const walkMs = pathLen * 160 + 40;
        this.time.delayedCall(walkMs, () => {
          const live = this.npcs.get(agentId);
          if (!live) return;
          this.startChoreoFor(live, act.choreo);
          if (behaviorId === "task") {
            const subagentType =
              ((act.event.metadata as { subagentType?: string } | undefined)
                ?.subagentType) ||
              ((act.event.metadata as { input?: Record<string, unknown> } | undefined)
                ?.input as { subagent_type?: string } | undefined)?.subagent_type;
            this.spawnHelperFor(live, subagentType);
          } else if (live.helper) {
            this.despawnHelper(live);
          }
        });
      }
    });

    // React to dynamic NPCs appearing/disappearing (only in interior zone)
    this.unsubscribeGame = useNpcStore.subscribe((state, prev) => {
      if (this.zone.id !== "interior") return;
      const prevIds = new Set(Object.keys(prev.dynamic));
      const nextIds = new Set(Object.keys(state.dynamic));
      for (const id of nextIds) {
        if (!prevIds.has(id)) this.addNpcEntity(state.dynamic[id]);
      }
      for (const id of prevIds) {
        if (!nextIds.has(id)) this.removeNpcEntity(id);
      }
    });

    // React → Phaser bridge. When a React component (roster row, receptionist
    // dialog) calls `useWorldBus.getState().summonAgent(id)`, the store bumps
    // summonTick[id]. We diff against lastSeenSummonTicks and call summonNpc
    // once per increment. No direct Phaser coupling in React.
    const busUnsub = useWorldBus.subscribe((state) => {
      for (const [id, tick] of Object.entries(state.summonTick)) {
        const prev = this.lastSeenSummonTicks[id] ?? 0;
        if (tick > prev) {
          this.lastSeenSummonTicks[id] = tick;
          this.summonNpc(id);
        }
      }
    });
    const prevUnsubGame = this.unsubscribeGame;
    this.unsubscribeGame = () => {
      prevUnsubGame?.();
      busUnsub();
    };

    // Dialog-open/close counts as "real interaction" for the cinema loop —
    // an NPC we just chatted with shouldn't be yanked to the lounge
    // immediately after.
    this.unsubDialogActive = useGameStore.subscribe((state, prev) => {
      if (state.dialog.active !== prev.dialog.active) {
        const npcId = state.dialog.npcId ?? prev.dialog.npcId;
        if (npcId) this.lastActivityAt.set(npcId, this.time.now);
      }
    });
  }

  // --------------------------------------------------------------------
  // per-frame
  // --------------------------------------------------------------------
  update(_time: number, _delta: number) {
    this.tickNpcPaths();
    this.tickChoreoDecay();
    this.tickFollowCamera();
    this.tickSpriteSeparation();
    this.tickEmptyStateHints();
    this.tickOverheadPills();
    this.tickTransitBadges();
    this.tickThinkingBadges();
    this.drawTethers();
    this.drawDebugOverlay();
  }

  /** Visual-only push-apart so two NPCs whose sprites end up overlapping
   *  drift a few pixels in opposite directions instead of blending into
   *  a single silhouette. We do NOT touch npc.col/npc.row — the
   *  pathfinder still treats them as occupying their authored cell. */
  private tickSpriteSeparation() {
    const SEPARATION_RADIUS = 18; // smaller than a tile (32) on purpose
    const PUSH_PER_FRAME = 0.6;
    const MAX_OFFSET = 14;
    for (const [aId, a] of this.npcs) {
      if (!a.sprite || !a.sprite.scene) continue;
      // Skip mid-step tweens (the walk owns the position) and seated
      // agents (they occupy a fixed pixel offset on the chair).
      if (a.tween) continue;
      if (this.seatByNpc.has(aId)) continue;
      let dx = 0;
      let dy = 0;
      for (const [bId, b] of this.npcs) {
        if (bId === aId) continue;
        if (!b.sprite || !b.sprite.scene) continue;
        const distX = a.sprite.x - b.sprite.x;
        const distY = a.sprite.y - b.sprite.y;
        const dist = Math.hypot(distX, distY) || 0.0001;
        if (dist >= SEPARATION_RADIUS) continue;
        // Symmetric push proportional to overlap.
        const overlap = (SEPARATION_RADIUS - dist) / SEPARATION_RADIUS;
        dx += (distX / dist) * overlap;
        dy += (distY / dist) * overlap;
      }
      if (dx === 0 && dy === 0) continue;
      // Cap the per-frame nudge so two clustered agents don't pop apart
      // explosively — we want a subtle "make room" motion.
      const mag = Math.hypot(dx, dy) || 1;
      const stepX = (dx / mag) * PUSH_PER_FRAME;
      const stepY = (dy / mag) * PUSH_PER_FRAME;
      // Cap total drift from the canonical tile center so a sprite
      // never reads as being in a different tile than npc.col/npc.row.
      const centerX = a.col * TILE_SIZE + TILE_SIZE / 2;
      const centerY = a.row * TILE_SIZE + TILE_SIZE / 2;
      const offX = a.sprite.x + stepX - centerX;
      const offY = a.sprite.y + stepY - centerY;
      const offMag = Math.hypot(offX, offY);
      const scale = offMag > MAX_OFFSET ? MAX_OFFSET / offMag : 1;
      const nextX = centerX + offX * scale;
      const nextY = centerY + offY * scale;
      a.sprite.setPosition(nextX, nextY);
      a.shadow.setPosition(nextX, nextY + 7);
    }
  }

  /**
   * Debug inspector — toggled by `D`. Draws a red border around every
   * Tiled object (rooms, seats, decor, collision) and a green dot at
   * each NPC's tile-anchor cell so you can see what coordinate the
   * pathfinder + render layout are actually using.
   */
  private drawDebugOverlay() {
    const gfx = this.debugGfx;
    if (!gfx || !this.debugVisible) return;
    gfx.clear();

    // Tiled objects — red rectangles. Slight color variation by
    // category so collision/seat/decor are tellable apart at a glance:
    //   - Collidable (walls): solid red
    //   - Seats: orange-red
    //   - Other rects (rooms, decor): pink-red, thinner
    for (const o of this.debugObjects) {
      const color = o.collidable ? 0xff2222 : o.seat ? 0xff7733 : 0xff66aa;
      const alpha = o.collidable ? 0.95 : 0.7;
      gfx.lineStyle(o.collidable ? 2 : 1, color, alpha);
      gfx.strokeRect(o.x, o.y, o.width, o.height);
    }

    // NPC anchor cells — bright green dot at the (col,row) tile center
    // the rest of the system uses for pathfinding and pill placement.
    for (const [, npc] of this.npcs) {
      if (!npc.sprite || !npc.sprite.scene) continue;
      const cx = npc.col * TILE_SIZE + TILE_SIZE / 2;
      const cy = npc.row * TILE_SIZE + TILE_SIZE / 2;
      gfx.fillStyle(0x22c55e, 1);
      gfx.fillCircle(cx, cy, 4);
      gfx.lineStyle(1, 0x000000, 0.8);
      gfx.strokeCircle(cx, cy, 4);
    }
  }

  /** Keep the always-on overhead pill glued above its sprite every frame.
   *  Also decays the brief ❌ error flash back to the baseline emoji. */
  private tickOverheadPills() {
    for (const [id, npc] of this.npcs) {
      if (!npc.overheadContainer || !npc.sprite.scene) continue;
      // Pin to sprite center; `-18` offsets above the head. NPCs use
      // origin (0.5, 1) so sprite.y is the bottom — subtract half a tile
      // to reach the head, then 18 more to clear the sprite.
      npc.overheadContainer.setPosition(
        npc.sprite.x,
        npc.sprite.y - TILE_SIZE - 6,
      );
      // Depth has to track row-ish so sprites in lower rows draw on top
      // of higher NPCs' pills. Using sprite.y is a fine proxy.
      npc.overheadContainer.setDepth(1600 + npc.sprite.y);

      // Pin the HELPER badge above the pill (sub-agents only).
      // Sits one row above the pill so it doesn't fight the thinking
      // badge for vertical space.
      if (npc.helperBadge) {
        npc.helperBadge.setPosition(
          npc.sprite.x,
          npc.sprite.y - TILE_SIZE - 36,
        );
        npc.helperBadge.setDepth(1599 + npc.sprite.y);
      }

      if (
        npc.overheadErrorUntil !== undefined &&
        this.time.now >= npc.overheadErrorUntil
      ) {
        npc.overheadErrorUntil = undefined;
        this.renderPill(id);
      }
      if (
        npc.overheadPromptUntil !== undefined &&
        this.time.now >= npc.overheadPromptUntil
      ) {
        npc.overheadPromptUntil = undefined;
        this.renderPill(id);
      }
    }
  }

  /**
   * Pull the most recent thinking excerpt from useAgentStore and float it
   * just below the overhead pill. Auto-expires after THINKING_BADGE_TTL_MS
   * of no change so a stale "thinking..." line doesn't sit there forever
   * once the agent moves on to a tool call.
   */
  private tickThinkingBadges() {
    const thinking = useAgentStore.getState().thinkingByAgent;
    const now = this.time.now;
    const TTL = 6000;
    // Visible width of the marquee box. Kept small so the badge
    // never sprawls — anything longer scrolls inside the box.
    const BOX_W = 72;
    const BOX_H = 14;
    const PAD_X = 4;
    // Pixels per second the text scrolls right-to-left.
    const SCROLL_SPEED = 22;
    // Gap between the end of one scroll-cycle and the start of the
    // next so the text reads as a loop rather than a smear.
    const TAIL_GAP = 28;

    for (const [id, npc] of this.npcs) {
      if (!npc.sprite || !npc.sprite.scene) continue;
      // Suppress while in transit — the walk badge owns that slot.
      const isTransiting = !!npc.transitTarget;
      const raw = isTransiting ? "" : thinking[id];
      const text = raw ? raw.replace(/\s+/g, " ").trim() : "";

      // Reset TTL whenever the text changes.
      if (text && text !== npc.thinkingText) {
        npc.thinkingText = text;
        npc.thinkingUpdatedAt = now;
      }

      const expired =
        npc.thinkingUpdatedAt !== undefined &&
        now - npc.thinkingUpdatedAt > TTL;

      if (!text || expired) {
        if (npc.thinkingBadge) {
          npc.thinkingBadge.container.destroy();
          npc.thinkingBadge.maskGfx.destroy();
          npc.thinkingBadge = undefined;
        }
        npc.thinkingText = undefined;
        npc.thinkingUpdatedAt = undefined;
        continue;
      }

      // Build (or reuse) the badge.
      if (!npc.thinkingBadge || npc.thinkingBadge.text.text !== text) {
        npc.thinkingBadge?.container.destroy();
        npc.thinkingBadge?.maskGfx.destroy();
        const container = this.add.container(0, 0).setAlpha(0.95);
        const bg = this.add.graphics();
        // The chip's background — solid paper-dim with mint border so
        // it reads as a UI affordance, not a void rectangle.
        bg.fillStyle(0x141827, 0.95);
        bg.fillRoundedRect(-BOX_W / 2, -BOX_H / 2, BOX_W, BOX_H, 3);
        bg.lineStyle(1, 0x2a3150, 1);
        bg.strokeRoundedRect(-BOX_W / 2, -BOX_H / 2, BOX_W, BOX_H, 3);

        // Only the text scrolls; mask it (NOT the bg) so the chip's
        // border + fill stay visible at the box's full width and the
        // characters cleanly disappear at the edges.
        const t = this.add.text(0, 0, text, {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: "8px",
          color: "#d5d8ff",
          resolution: 3,
        });
        t.setOrigin(0, 0.5);
        const measured = t.width;
        const innerW = BOX_W - PAD_X * 2;
        const overflows = measured > innerW;

        // Initial text x: left-aligned (with PAD) when it fits, otherwise
        // start at the left edge so the marquee scrolls leftward.
        if (overflows) {
          t.setPosition(-BOX_W / 2 + PAD_X, 0);
        } else {
          t.setPosition(-measured / 2, 0);
        }

        container.add(bg);
        container.add(t);

        // Mask the TEXT to the inner box. The mask must follow the
        // container's world position each frame — Phaser geometry
        // masks read the gfx's world transform.
        const maskGfx = this.make
          .graphics({ x: 0, y: 0 })
          .fillRect(-innerW / 2, -BOX_H / 2 + 1, innerW, BOX_H - 2);
        const mask = maskGfx.createGeometryMask();
        t.setMask(mask);

        npc.thinkingBadge = {
          container,
          bg,
          text: t,
          maskGfx,
          pixelWidth: measured,
          boxWidth: innerW,
          boxHeight: BOX_H,
        };
      }

      const badge = npc.thinkingBadge!;
      // Marquee: scroll the text leftward when it doesn't fit.
      const overflows = badge.pixelWidth > badge.boxWidth;
      if (overflows) {
        const cycle = badge.pixelWidth + TAIL_GAP;
        const elapsedMs = now - (npc.thinkingUpdatedAt ?? now);
        const offset = ((elapsedMs / 1000) * SCROLL_SPEED) % cycle;
        badge.text.setX(-BOX_W / 2 + PAD_X - offset);
      }
      // Pin to sprite each frame so it follows movement.
      const cx = npc.sprite.x;
      const cy = npc.sprite.y - TILE_SIZE - 22;
      badge.container.setPosition(cx, cy);
      badge.container.setDepth(1599 + npc.sprite.y);
      // The mask gfx isn't a child of the container — it lives in
      // world space, so we have to follow the container manually.
      badge.maskGfx.setPosition(cx, cy);
    }
  }

  /**
   * Render a small "🚶 → Library" subtitle below the pill while the
   * agent is mid-path. The label tracks the destination room so the
   * user knows the movement was intentional, not random.
   */
  private tickTransitBadges() {
    for (const [, npc] of this.npcs) {
      if (!npc.sprite || !npc.sprite.scene) continue;
      const target = npc.transitTarget;
      const text = target
        ? `🚶 → ${roomById(target)?.label ?? target}`
        : "";

      if (!text) {
        if (npc.transitBadge) {
          npc.transitBadge.destroy();
          npc.transitBadge = undefined;
          npc.transitText = undefined;
        }
        continue;
      }

      if (!npc.transitBadge) {
        npc.transitBadge = this.add
          .text(npc.sprite.x, npc.sprite.y - TILE_SIZE - 22, text, {
            fontFamily: '"Press Start 2P", monospace',
            fontSize: "8px",
            color: "#6ee7b7",
            backgroundColor: "#141827",
            padding: { x: 4, y: 2 },
            resolution: 3,
          })
          .setOrigin(0.5, 1)
          .setDepth(1599 + npc.sprite.y)
          .setAlpha(0.95);
        npc.transitText = text;
      } else {
        if (npc.transitText !== text) {
          npc.transitBadge.setText(text);
          npc.transitText = text;
        }
        npc.transitBadge.setPosition(
          npc.sprite.x,
          npc.sprite.y - TILE_SIZE - 22,
        );
        npc.transitBadge.setDepth(1599 + npc.sprite.y);
      }
    }
  }

  /**
   * Follow-mode camera: when useGameStore.followNpcId is set, center the
   * camera on that NPC's sprite with a smooth pan. Throttled to ~2 Hz so
   * we don't kill a pan tween on every frame.
   */
  private tickFollowCamera() {
    const followId = useGameStore.getState().followNpcId;
    if (!followId) return;
    const npc = this.npcs.get(followId);
    if (!npc || !npc.sprite || !npc.sprite.scene) return;
    const now = this.time.now;
    if (now - this.lastFollowPanAt < 500) return;
    this.lastFollowPanAt = now;
    this.cameras.main.pan(
      npc.sprite.x,
      npc.sprite.y,
      400,
      "Sine.easeInOut",
      true,
    );
  }

  /**
   * Each frame, redraw the small dotted lines that visually connect every
   * sub-agent NPC to its parent.
   */
  private drawTethers() {
    if (!this.tetherGfx) return;
    this.tetherGfx.clear();
    for (const npc of this.npcs.values()) {
      const pid = (npc.def as { parentId?: string }).parentId;
      if (!pid) continue;
      const parent = this.npcs.get(pid);
      if (!parent) continue;
      // Mint-dark — same as the in-app accent so the tether reads as
      // a UI affordance, not part of the world tile palette.
      this.tetherGfx.lineStyle(2, 0x22c55e, 0.8);
      // Draw 5 small dashes between the two sprites.
      const segments = 5;
      for (let i = 0; i < segments; i++) {
        const t1 = (i + 0.1) / segments;
        const t2 = (i + 0.5) / segments;
        const x1 = Phaser.Math.Linear(parent.sprite.x, npc.sprite.x, t1);
        const y1 = Phaser.Math.Linear(parent.sprite.y, npc.sprite.y, t1);
        const x2 = Phaser.Math.Linear(parent.sprite.x, npc.sprite.x, t2);
        const y2 = Phaser.Math.Linear(parent.sprite.y, npc.sprite.y, t2);
        this.tetherGfx.lineBetween(x1, y1, x2, y2);
      }
    }
  }

  /**
   * If a NPC has been running a non-idle choreo for >12s without a new
   * activity, drop back to idle-bob so it doesn't hammer forever. Cheap
   * check once per frame.
   */
  private tickChoreoDecay() {
    const now = this.time.now;
    for (const [, npc] of this.npcs) {
      if (!npc.choreo) continue;
      if (npc.choreo.kind === "idle-bob") continue;
      if (now - npc.choreo.startedAt < 12000) continue;
      this.startChoreoFor(npc, "idle-bob");
      // If a helper is still hanging around from a Task, despawn it too.
      if (npc.helper) this.despawnHelper(npc);
    }
  }

  // --------------------------------------------------------------------
  // NPC pathfinding / auto-walk
  // --------------------------------------------------------------------
  walkNpcToRoom(npcId: string, room: RoomId) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    const anchor = ROOM_ANCHORS[room];

    // Find a free tile near the anchor — anchor itself or adjacent
    let target = { col: anchor.col, row: anchor.row };
    let targetFound =
      this.isWalkableHere(target.col, target.row) &&
      !this.isEntityAt(target.col, target.row, npcId);
    if (!targetFound) {
      const candidates = [
        [anchor.col + 1, anchor.row],
        [anchor.col - 1, anchor.row],
        [anchor.col, anchor.row + 1],
        [anchor.col, anchor.row - 1],
      ];
      for (const [c, r] of candidates) {
        if (this.isWalkableHere(c, r) && !this.isEntityAt(c, r, npcId)) {
          target = { col: c, row: r };
          targetFound = true;
          break;
        }
      }
    }
    // Anchor cluster fully blocked — scan the whole room rect for any
    // walkable, unoccupied cell. Without this, a crowded room silently
    // refuses new arrivals and they freeze in the corridor.
    if (!targetFound) {
      const region = getRoomRegions().find((r) => r.id === room);
      if (region) {
        outer: for (let r = region.rowMin; r <= region.rowMax; r++) {
          for (let c = region.colMin; c <= region.colMax; c++) {
            if (this.isWalkableHere(c, r) && !this.isEntityAt(c, r, npcId)) {
              target = { col: c, row: r };
              targetFound = true;
              break outer;
            }
          }
        }
      }
      if (!targetFound) {
        console.warn(
          `[walkNpcToRoom] room "${room}" is full — ${npcId} stays put`,
        );
        return;
      }
    }

    const blocked: Array<{ col: number; row: number }> = [];
    for (const other of this.npcs.values()) {
      if (other.def.id === npcId) continue;
      blocked.push({ col: other.col, row: other.row });
    }
    const path = bfs(npc.col, npc.row, target.col, target.row, { blocked });
    if (path.length <= 1) return;
    this.npcPaths.set(npcId, path.slice(1));
    // Stash the destination room on the entity so the transit badge
    // ("→ Library") can render until the path drains.
    npc.transitTarget = room;
  }

  private isEntityAt(col: number, row: number, exceptNpcId?: string): boolean {
    for (const n of this.npcs.values()) {
      if (n.def.id === exceptNpcId) continue;
      if (n.col === col && n.row === row) return true;
    }
    return false;
  }

  private tickNpcPaths() {
    for (const [id, path] of this.npcPaths) {
      const npc = this.npcs.get(id);
      // Defensive: if the npc entry is gone, or its sprite was destroyed
      // (e.g. by a mid-flight scene restart or a late tween onComplete
      // that ran after removeNpcEntity), drop the path. `sprite.active`
      // is Phaser's "is this game object still usable" flag.
      if (!npc || !npc.sprite || !npc.sprite.scene) {
        this.npcPaths.delete(id);
        continue;
      }
      if (npc.tween) continue; // mid-step
      const next = path.shift();
      if (!next) {
        this.npcPaths.delete(id);
        npc.transitTarget = undefined;
        try {
          // Drop into the per-character idle loop so the agent looks
          // alive at rest instead of holding a single frame.
          this.playIdleAnim(npc);
        } catch {
          // sprite torn down while we were iterating — ignore
        }
        continue;
      }
      // Path could have become invalid if the player stepped into it — retry later
      if (this.isEntityAt(next.col, next.row, id)) {
        path.unshift(next);
        continue;
      }
      const dc = next.col - npc.col;
      const dr = next.row - npc.row;
      const dir: Direction = dc > 0 ? "right" : dc < 0 ? "left" : dr > 0 ? "down" : "up";
      npc.facing = dir;
      npc.sprite.play(`${npc.animKey}-walk-${dir}`, true);
      // On the LAST step of a seat-bound path, prefer the seat's
      // authored pixel center (via npcSeatOffset). Cleared on arrival.
      const isLastStep = path.length === 0;
      const offset = isLastStep ? this.npcSeatOffset.get(id) : undefined;
      const targetX = offset
        ? offset.px
        : next.col * TILE_SIZE + TILE_SIZE / 2;
      const targetY = offset
        ? offset.py
        : next.row * TILE_SIZE + TILE_SIZE / 2;
      npc.tween = this.tweens.add({
        targets: npc.sprite,
        x: targetX,
        y: targetY,
        duration: STEP_DURATION_MS,
        ease: "Linear",
        onComplete: () => {
          npc.col = next.col;
          npc.row = next.row;
          npc.sprite.setDepth(1000 + next.row);
          npc.tween = undefined;
          if (offset) {
            // Force facing toward camera so seated agents look out at
            // the player rather than wherever the last step came from.
            npc.facing = "down";
            try {
              npc.sprite.stop();
              // Swap to the seated pose from the per-character sit
              // sheet. Frame 0 of the matching direction is the
              // resting "sat at desk" silhouette.
              npc.sprite.setTexture(npc.sitSheetKey, SIT_FRAME.down);
            } catch {
              // sprite torn down mid-tween — ignore
            }
            this.npcSeatOffset.delete(id);
            // Sit-down choreo: brief settle + breathing yoyo so the
            // seated pose reads as intentional rather than frozen.
            this.startChoreoFor(npc, "sit-down");
          }
        },
      });
      this.tweens.add({
        targets: npc.shadow,
        x: targetX,
        y: targetY + 7,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
      if (npc.indicator) {
        this.tweens.add({
          targets: npc.indicator,
          x: targetX,
          y: targetY - 14,
          duration: STEP_DURATION_MS,
          ease: "Linear",
        });
      }
      if (npc.overheadContainer) {
        this.tweens.add({
          targets: npc.overheadContainer,
          x: targetX,
          y: targetY - 20,
          duration: STEP_DURATION_MS,
          ease: "Linear",
        });
      }
    }
  }

  // --------------------------------------------------------------------
  // misc
  // --------------------------------------------------------------------
  private applyMicroAnim(entity: Entity, anim: AnimationId) {
    // keep simple — no extra bobbing while we have dialog/movement
    if (anim === "typing" || anim === "use_machine" || anim === "testing") {
      // could add a subtle bob here
    }
  }

  // --------------------------------------------------------------------
  // Choreography helpers
  // --------------------------------------------------------------------

  /**
   * Start (or switch to) a choreography on an NPC entity. Stops the previous
   * choreo if any so we never stack tweens.
   */
  private startChoreoFor(
    entity: Entity & { def: NpcDef; tween?: Phaser.Tweens.Tween },
    kind: ChoreoKind,
  ) {
    if (entity.choreo) {
      if (entity.choreo.kind === kind) {
        // Same choreo already running — refresh its start time and return.
        entity.choreo.startedAt = this.time.now;
        return;
      }
      try {
        entity.choreo.handle.stop();
      } catch {
        // ignore
      }
      // choreo.stop() resets scale to (1, 1). Re-apply our resting scale
      // so sub-agents stay at 0.8 between choreos.
      try {
        entity.sprite.setScale(entity.restingScale);
      } catch {
        // ignore
      }
      entity.choreo = undefined;
    }
    const handle = startChoreo(this, { sprite: entity.sprite }, kind);
    entity.choreo = { kind, handle, startedAt: this.time.now };
  }

  private stopChoreoFor(entity: Entity) {
    if (!entity.choreo) return;
    try {
      entity.choreo.handle.stop();
    } catch {
      // ignore
    }
    try {
      entity.sprite.setScale(entity.restingScale);
    } catch {
      // ignore
    }
    entity.choreo = undefined;
  }

  /**
   * Spawn a small helper "dwarf" sprite next to the parent while it's running
   * a `Task` (sub-agent) tool. Despawns on the next non-Task activity or on
   * removeNpcEntity.
   */
  private spawnHelperFor(
    entity: Entity & { def: NpcDef },
    subagentType: string | undefined,
  ) {
    // If there's already a helper, just leave it; the dispose will happen on
    // the next non-Task activity.
    if (entity.helper) return;

    // Pick a Modern character that is NOT the parent's. Hash the
    // sub-agent type so the same task tool (e.g. "general-purpose")
    // always produces the same helper face.
    const tintSeed = (subagentType ?? "default")
      .split("")
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
    const parentChar = this.characterForNpc(entity.def.id);
    const candidates = MODERN_CHARS.filter((c) => c !== parentChar);
    const helperChar =
      candidates[Math.abs(tintSeed) % candidates.length] ?? parentChar;
    const helperKey = MODERN_KEY(helperChar);
    this.ensureAnimsForSheet(helperKey);

    // Spawn 1 tile behind the parent's facing direction.
    const [dc, dr] = dirDelta(oppositeDir(entity.facing));
    const spawnPx = entity.sprite.x + dc * TILE_SIZE;
    const spawnPy = entity.sprite.y + dr * TILE_SIZE;

    const sprite = this.add
      .sprite(spawnPx, spawnPy, helperKey, 0)
      // Helper at 0.75 — visibly smaller than its parent (1) so it reads
      // as a subordinate. Modern sprites are 16w × 32h native, so this
      // is the same proportional reduction that the old 1.5/2 was.
      .setScale(0.75)
      .setDepth(entity.sprite.depth - 1);

    // Floating emoji above the helper — scroll.
    const emojiText = this.add
      .text(spawnPx, spawnPy - 10, "📜", {
        fontSize: "8px",
        resolution: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(sprite.depth + 200);

    // Pop-in tween.
    sprite.setAlpha(0);
    this.tweens.add({
      targets: sprite,
      alpha: 1,
      scale: { from: 0.3, to: 0.75 },
      duration: 220,
      ease: "Back.easeOut",
    });

    const followUpdate = () => {
      if (!sprite.scene) return;
      // Follow the parent with a 1-tile offset behind its facing.
      const [ddc, ddr] = dirDelta(oppositeDir(entity.facing));
      const tx = entity.sprite.x + ddc * TILE_SIZE;
      const ty = entity.sprite.y + ddr * TILE_SIZE;
      // Smooth follow so it tweens naturally.
      sprite.x = Phaser.Math.Linear(sprite.x, tx, 0.1);
      sprite.y = Phaser.Math.Linear(sprite.y, ty, 0.1);
      emojiText.x = sprite.x;
      emojiText.y = sprite.y - 10;
    };
    this.events.on(Phaser.Scenes.Events.UPDATE, followUpdate);

    const destroy = () => {
      this.events.off(Phaser.Scenes.Events.UPDATE, followUpdate);
      this.tweens.add({
        targets: [sprite, emojiText],
        alpha: 0,
        scale: 0.3,
        duration: 180,
        onComplete: () => {
          try {
            sprite.destroy();
          } catch {
            // ignore
          }
          try {
            emojiText.destroy();
          } catch {
            // ignore
          }
          // Clean up the temp texture so it doesn't leak if the session has
          // dozens of sub-agent calls.
          try {
            if (this.textures.exists(helperKey)) {
              this.textures.remove(helperKey);
            }
          } catch {
            // ignore
          }
        },
      });
    };

    entity.helper = { sprite, emojiText, followUpdate, destroy };
  }

  private despawnHelper(entity: Entity & { def?: NpcDef }) {
    if (!entity.helper) return;
    try {
      entity.helper.destroy();
    } catch {
      // ignore
    }
    entity.helper = undefined;
  }
}

// Helper: opposite direction — used to place the sub-agent helper "behind" the parent.
function oppositeDir(d: Direction): Direction {
  switch (d) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "up":
      return "down";
    case "down":
      return "up";
  }
}

function dirDelta(d: Direction): [number, number] {
  switch (d) {
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "up":
      return [0, -1];
    case "down":
      return [0, 1];
  }
}

export const worldSceneConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  // Starting size is just a reasonable default; the renderer's size is
  // controlled dynamically by GameCanvasInner calling `game.scale.resize(w,h)`
  // whenever the host panel changes shape. The view never letterboxes.
  width: NATIVE_W,
  height: NATIVE_H,
  pixelArt: true,
  roundPixels: true,
  // Match the page chrome color (`bg-page` in src/app/globals.css) so
  // any unrendered area at the canvas edges blends into the frame.
  backgroundColor: "#271d2e",
  scene: [WorldScene],
  scale: { mode: Phaser.Scale.NONE },
  input: { keyboard: true },
};

export { NATIVE_W, NATIVE_H };
