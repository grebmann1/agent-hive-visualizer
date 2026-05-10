import Phaser from "phaser";
import {
  eventToolName,
  type AgentEvent,
  type AnimationId,
  type RoomId,
} from "../events/types";
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
import { ROOM_ANCHORS, getRoomRegions, roomIdForCell } from "./rooms";
import { roomById } from "./room-registry";
import {
  EXTERIOR_ANCHORS,
  isWalkableIn,
  loadInteriorZone,
  type ZoneDef,
} from "./zones";
import { resolveGid, type DeskRect, type SeatCell } from "./tiled-loader";
import { download as downloadAgentLog, logAgent, size as agentLogSize } from "./agentLog";
import {
  type ChoreoHandle,
  type ChoreoKind,
  startChoreo,
} from "./choreo";
import { useSettingsStore } from "../stores/useSettingsStore";
import { WORLD_LIFE_TUNABLES } from "./world-life/tunables";
import {
  formatTransitionLog,
  makeCooldowns,
  microCooldown,
  nextState as worldLifeNextState,
  setMicroCooldown,
  setSigCooldown,
  sigCooldown,
  snapshotCooldownsS,
  worldLifeDebug,
  type WorldLifeState,
  type WorldLifeTrigger,
} from "./world-life/state-machine";
import { IdleAnimController, type IdleContextProvider } from "./world-life/idle-anims";
import {
  startLoungeSignature,
  type LoungeSignatureHandle,
  type PersistedMugHandle,
} from "./world-life/lounge-signature";
import { DwellTracker } from "./world-life/dwell-ladder";
import { startMicroTrip, type MicroTripHandle } from "./world-life/micro-trip";
import { ChitChatEngine, type ChatSession, type AgentMood, chatProbForRoom } from "./world-life/chit-chat-engine";
import { showChatBubble, bubbleSide, type ChatBubbleHandle } from "./world-life/chat-bubble";

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

// Camera control constants (v2.0 free-pan mode).
const DRAG_THRESHOLD_PX = 4;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

/** Label shown on the overhead pill. Prefers the agent's display name
 *  so it matches the right-side roster row exactly. Falls back to the
 *  cwd basename, then a stable 4-char id suffix. Truncated to 14
 *  characters to keep the pill compact. */
function pillLabelFor(def: {
  id: string;
  name?: string;
  cwd?: string;
}): string {
  if (def.name && def.name.trim()) return def.name.slice(0, 14);
  if (def.cwd) {
    const base = def.cwd.split(/[/\\]/).filter(Boolean).pop();
    if (base) return base.slice(0, 14);
  }
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
  // Full-canvas tint that drifts with the system clock. Painted at
  // depth 100 so sprites stay legible — the rectangle is purely a
  // mood layer, not a shader.
  private todOverlay?: Phaser.GameObjects.Rectangle;
  private todTimer?: Phaser.Time.TimerEvent;
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

  // ------------------------------------------------------------------
  // World-life v2 (spec §2 + §9) — Stage 1, behind `worldLifeV2` flag.
  // The timer is created lazily once the flag is on; with the flag off
  // none of these are touched, so behaviour stays byte-identical to
  // pre-v2. Visual side effects come in later tickets (#241/238/237/240).
  // ------------------------------------------------------------------
  private worldLifeTimer: Phaser.Time.TimerEvent | null = null;
  private idleAnimCtrl: IdleAnimController | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  /** Wall-clock ms (Date.now()) the NPC last received a tool event.
   *  Used to drive the ACTIVE_TOOL → ROOM_IDLE transition after
   *  TOOL_QUIET_S. Separate from `lastActivityAt` (scene clock, used by
   *  the existing cinema loop) so the FSM can stand on its own clock. */
  private worldLifeLastToolAt = new Map<string, number>();

  // ------------------------------------------------------------------
  // World-life Stage 2 — lounge signature visual state
  // ------------------------------------------------------------------
  /** Active lounge-signature handle per NPC. Present while the ritual is
   *  in flight; removed when the sequence finishes or is preempted. */
  private loungeSignatures = new Map<string, LoungeSignatureHandle>();
  /** Persisted mug overlays per NPC — active when the agent left the
   *  lounge but the mug hasn't decayed yet (10s window). */
  private persistedMugs = new Map<string, PersistedMugHandle>();

  // ------------------------------------------------------------------
  // World-life Stage 4 — dwell ladder + micro-trips
  // ------------------------------------------------------------------
  private dwellTracker: DwellTracker | null = null;
  private microTrips = new Map<string, MicroTripHandle>();

  // ------------------------------------------------------------------
  // World-life Stage 5 — chit-chat engine + bubble rendering
  // ------------------------------------------------------------------
  private chatEngine: ChitChatEngine | null = null;
  private activeBubbles = new Map<string, ChatBubbleHandle>(); // npcId → bubble
  private chatAdvanceTimers = new Map<number, Phaser.Time.TimerEvent>(); // sessionId → next-advance timer

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
      // Sit sheet — directional 24-frame variant (6 frames per
      // direction, same layout as the run/idle sheets). Indexing via
      // SIT_FRAME[npc.facing] picks the back/side/front pose so a
      // seated agent faces their desk instead of the camera.
      this.load.spritesheet(
        MODERN_SIT_KEY(c),
        `/assets/sprites/modern/${c}_sit_16x16.png`,
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
    this.deskRects = bundle.parsed.deskRects.slice();
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
    this.subscribeWorldLifeFlag();
    this.createTimeOfDayOverlay(mapW, mapH);
    this.createRoomAmbience();

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

    // Shift+E downloads the in-memory agent motion log as JSON.
    // Used to diagnose teleport reports — the log captures every
    // pixel/tile change so we can detect Δpx > TILE between
    // consecutive entries for the same agent.
    this.input.keyboard?.on("keydown-E", (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      console.info(`[agentLog] downloading ${agentLogSize()} entries`);
      downloadAgentLog();
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
      this.worldLifeTimer?.destroy();
      this.worldLifeTimer = null;
      this.idleAnimCtrl?.destroy();
      this.idleAnimCtrl = null;
      for (const h of this.loungeSignatures.values()) h.stop();
      this.loungeSignatures.clear();
      for (const h of this.persistedMugs.values()) h.destroy();
      this.persistedMugs.clear();
      this.dwellTracker?.destroy();
      this.dwellTracker = null;
      for (const h of this.microTrips.values()) h.stop();
      this.microTrips.clear();
      // Stage 5: destroy chat engine + bubbles + timers on shutdown
      this.chatEngine?.destroy();
      this.chatEngine = null;
      for (const b of this.activeBubbles.values()) b.destroy();
      this.activeBubbles.clear();
      for (const t of this.chatAdvanceTimers.values()) t.remove(false);
      this.chatAdvanceTimers.clear();
      this.unsubscribeSettings?.();
      this.unsubscribeSettings = null;
      this.worldLifeLastToolAt.clear();
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
  // Cell-coord bounds of every "Desk" object — read at seat-snap time
  // so a seated agent faces the nearest desk instead of the camera.
  private deskRects: DeskRect[] = [];

  /** Pick which way a seated agent should face. We look for the
   *  nearest desk rect to the seat cell and return up/down/left/right
   *  based on the dominant axis. Falls back to "up" (the dominant
   *  layout in the authored map) when no desks exist. */
  private deskFacingFor(col: number, row: number): Direction {
    if (this.deskRects.length === 0) return "up";
    const cx = col + 0.5;
    const cy = row + 0.5;
    let best: DeskRect | null = null;
    let bestDist = Infinity;
    for (const d of this.deskRects) {
      const dcx = (d.colMin + d.colMax + 1) / 2;
      const dcy = (d.rowMin + d.rowMax + 1) / 2;
      const dx = dcx - cx;
      const dy = dcy - cy;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    if (!best) return "up";
    const dcx = (best.colMin + best.colMax + 1) / 2;
    const dcy = (best.rowMin + best.rowMax + 1) / 2;
    const dx = dcx - cx;
    const dy = dcy - cy;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
    return dy > 0 ? "down" : "up";
  }

  private startIdleSitLoop() {
    if (this.zone.id !== "interior") return;
    this.idleSitTimer = this.time.addEvent({
      delay: 2000,
      loop: true,
      callback: () => this.tickIdleSit(),
    });
  }

  /** Paint a full-map mood rectangle over the world that drifts with
   *  the wall-clock hour: warm dawn, neutral midday, cool dusk, deep
   *  night. The overlay is a single Rectangle at depth 100, low alpha
   *  so the underlying tiles stay legible. Refreshed once a minute. */
  private createTimeOfDayOverlay(mapW: number, mapH: number) {
    const rect = this.add
      .rectangle(0, 0, mapW, mapH, 0xffffff, 0)
      .setOrigin(0, 0)
      .setDepth(100);
    this.todOverlay = rect;
    this.refreshTimeOfDay();
    this.todTimer = this.time.addEvent({
      delay: 60_000,
      loop: true,
      callback: () => this.refreshTimeOfDay(),
    });
  }

  /** Anchor a small ambient emoji per curated room so empty rooms
   *  feel less inert. The sprite tweens scaleY ↔ 0.94 on a slow yoyo
   *  to read as "alive but quiet". Depth 5 keeps it above the floor
   *  but below NPCs and tethers. Each room gets at most one. */
  private createRoomAmbience() {
    const AMBIENT: Partial<Record<RoomId, string>> = {
      library: "📚",
      desk: "☕",
      meeting_room: "📺",
      testing_lab: "🧪",
    };
    for (const region of getRoomRegions()) {
      const emoji = AMBIENT[region.id];
      if (!emoji) continue;
      // Anchor near the bottom-left of the room rect rather than the
      // center so the decoration doesn't fight a seat for the same
      // tile. Tile-grid aligned.
      const cx = (region.colMin + 1) * TILE_SIZE + TILE_SIZE / 2;
      const cy = (region.rowMax) * TILE_SIZE + TILE_SIZE / 2;
      const t = this.add
        .text(cx, cy, emoji, { fontSize: "14px", resolution: 2 })
        .setOrigin(0.5, 1)
        .setDepth(5)
        .setAlpha(0.55);
      this.tweens.add({
        targets: t,
        scaleY: { from: 1, to: 0.94 },
        duration: 2400,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  private refreshTimeOfDay() {
    if (!this.todOverlay) return;
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    // Six anchor points around the day. Each is { hour, color, alpha }.
    // The overlay lerps between the two anchors flanking `hour`.
    const ANCHORS: Array<{ h: number; rgb: number; a: number }> = [
      { h: 0, rgb: 0x1a1f4d, a: 0.32 }, // late night
      { h: 5, rgb: 0xff9e7a, a: 0.18 }, // dawn
      { h: 9, rgb: 0xffffff, a: 0.0 }, // morning (clear)
      { h: 13, rgb: 0xfff7c0, a: 0.06 }, // midday
      { h: 18, rgb: 0xffa066, a: 0.18 }, // dusk
      { h: 21, rgb: 0x1a1f4d, a: 0.32 }, // night
    ];
    let lo = ANCHORS[ANCHORS.length - 1];
    let hi = ANCHORS[0];
    for (let i = 0; i < ANCHORS.length; i++) {
      const a = ANCHORS[i];
      const b = ANCHORS[(i + 1) % ANCHORS.length];
      const aH = a.h;
      const bH = b.h <= a.h ? b.h + 24 : b.h;
      const h = hour < a.h ? hour + 24 : hour;
      if (h >= aH && h <= bH) {
        lo = a;
        hi = b;
        break;
      }
    }
    const span = ((hi.h <= lo.h ? hi.h + 24 : hi.h) - lo.h) || 1;
    const t = ((hour < lo.h ? hour + 24 : hour) - lo.h) / span;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const rA = (lo.rgb >> 16) & 0xff;
    const gA = (lo.rgb >> 8) & 0xff;
    const bA = lo.rgb & 0xff;
    const rB = (hi.rgb >> 16) & 0xff;
    const gB = (hi.rgb >> 8) & 0xff;
    const bB = hi.rgb & 0xff;
    const r = Math.round(lerp(rA, rB));
    const g = Math.round(lerp(gA, gB));
    const b2 = Math.round(lerp(bA, bB));
    this.todOverlay.fillColor = (r << 16) | (g << 8) | b2;
    this.todOverlay.fillAlpha = lerp(lo.a, hi.a);
  }

  private tickIdleSit() {
    if (useGameStore.getState().dialog.active) return;
    const now = this.time.now;
    // An NPC is "idle" if it hasn't had a real activity / summon / dialog
    // interaction in the last minute. After that it heads to the lounge
    // (coffee bar) to hang out until the player calls it again.
    const IDLE_MS = 60_000;
    const loungeAvailable = !!this.zone.anchors.lounge;

    for (const npc of this.npcs.values()) {
      // Already mid-path? Leave them alone.
      if (this.npcPaths.has(npc.def.id)) continue;
      // Already seated?
      if (this.seatByNpc.has(npc.def.id)) continue;
      // Not idle long enough yet.
      const last = this.lastActivityAt.get(npc.def.id) ?? 0;
      if (last !== 0 && now - last < IDLE_MS) continue;
      // Sub-agents follow their parent; don't drag them to the lounge.
      if ((npc.def as { parentId?: string }).parentId) continue;

      // Prefer routing idle agents to the lounge (coffee bar) — feels
      // more alive than every agent silently snapping back to a desk.
      // Fall back to a free seat if the map has no lounge anchor.
      if (loungeAvailable) {
        this.walkNpcToRoom(npc.def.id, "lounge");
        if (!this.lastActivityAt.has(npc.def.id)) {
          this.lastActivityAt.set(npc.def.id, now);
        }
        continue;
      }

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
        logAgent({
          ts: Date.now(),
          scene: this.time.now,
          agentId: npcId,
          kind: "texture-swap",
          note: `seat → run (${npc.animKey})`,
        });
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
      // Already in the target cell. Slide (don't snap) onto the chair's
      // authored pixel center so the move reads as a step, not a
      // teleport. Skip the tween if we're already on the offset.
      if (finalOffset) {
        const fromX = npc.sprite.x;
        const fromY = npc.sprite.y;
        const dx = finalOffset.px - fromX;
        const dy = finalOffset.py - fromY;
        const facing = this.deskFacingFor(targetCol, targetRow);
        npc.facing = facing;
        const applySeatedPose = () => {
          try {
            npc.sprite.stop();
            // Use the idle sheet's first frame for the chosen direction.
            npc.sprite.setTexture(npc.idleAnimKey, IDLE_FRAME[facing][0]);
          } catch {
            // ignore
          }
        };
        if (dx * dx + dy * dy < 0.25) {
          // Sub-pixel difference — no tween needed.
          applySeatedPose();
        } else {
          // Cancel any in-flight tween on this sprite to avoid a fight.
          this.tweens.killTweensOf(npc.sprite);
          this.tweens.killTweensOf(npc.shadow);
          this.tweens.add({
            targets: npc.sprite,
            x: finalOffset.px,
            y: finalOffset.py,
            duration: STEP_DURATION_MS,
            ease: "Linear",
            onComplete: applySeatedPose,
          });
          this.tweens.add({
            targets: npc.shadow,
            x: finalOffset.px,
            y: finalOffset.py + 7,
            duration: STEP_DURATION_MS,
            ease: "Linear",
          });
        }
        logAgent({
          ts: Date.now(),
          scene: this.time.now,
          agentId: npcId,
          kind: "seat-snap",
          fromX,
          fromY,
          toX: finalOffset.px,
          toY: finalOffset.py,
          note: `already-at-cell offset slide (face ${facing})`,
        });
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
      const delta = targetAlpha - t.alpha;
      if (Math.abs(delta) < 0.02) {
        // Snap to target so labels actually settle at 0 / 0.85
        // instead of asymptoting at ~0.019 forever.
        if (t.alpha !== targetAlpha) t.setAlpha(targetAlpha);
        continue;
      }
      // Smooth lerp during the transition.
      t.setAlpha(t.alpha + delta * 0.15);
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
    const targetCol = def.col;
    const targetRow = def.row;
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
      if (!ent) return;
      ent.pillHover = true;
      this.renderPill(def.id);
      // Skip the scale bump while a non-idle choreo is animating the
      // sprite — the sit-down squash and typing pulse already mutate
      // scaleY, and stacking another tween produces a wobble.
      if (ent.choreo && ent.choreo.kind !== "idle-bob") return;
      // Always pop relative to resting scale so multiple hovers in a
      // row don't compound (1.08× × 1.08× × … each pointerover).
      const target = ent.restingScale * 1.08;
      this.tweens.add({
        targets: sprite,
        scaleX: target,
        scaleY: target,
        duration: 120,
        ease: "Quad.easeOut",
      });
    });
    sprite.on("pointerout", () => {
      const ent = this.npcs.get(def.id);
      if (!ent) return;
      ent.pillHover = false;
      this.renderPill(def.id);
      if (ent.choreo && ent.choreo.kind !== "idle-bob") return;
      const target = ent.restingScale;
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

    // Floating badge above sub-agents. Reads like a chip on the
    // parent's tether, so the relationship is obvious without the
    // user having to spot the dotted line. Label prefers the
    // sub-agent's `subagentType` (e.g. "RESEARCHER", "TESTER") so
    // siblings can be told apart at a glance.
    let helperBadge: Phaser.GameObjects.Text | undefined;
    if (isSubAgent) {
      const subagentType = (def as { subagentType?: string }).subagentType;
      const label = subagentType
        ? subagentType.replace(/[-_]/g, " ").toUpperCase().slice(0, 12)
        : "HELPER";
      helperBadge = this.add
        .text(px, py - TILE_SIZE - 10, label, {
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
    this.idleAnimCtrl?.ensure(def.id);
    this.dwellTracker?.ensure(def.id, Date.now());

    logAgent({
      ts: Date.now(),
      scene: this.time.now,
      agentId: def.id,
      kind: "spawn",
      toCol: col,
      toRow: row,
      toX: px,
      toY: py,
      note: isSubAgent ? `sub-agent of ${parentId ?? "?"}` : undefined,
    });

    // Sub-agent appearance: flash the tether to the parent so the
    // delegation reads as an explicit handoff rather than a random
    // sprite popping in.
    if (isSubAgent && parentId) {
      this.flashTetherToParent(def.id, parentId);
    }

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
    const pendingTool = pending ? eventToolName(pending.event) : undefined;
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
    logAgent({
      ts: Date.now(),
      scene: this.time.now,
      agentId: id,
      kind: "remove",
      fromCol: npc.col,
      fromRow: npc.row,
      fromX: npc.sprite.x,
      fromY: npc.sprite.y,
    });

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
    this.idleAnimCtrl?.forget(id);
    this.dwellTracker?.forget(id);
    this.microTrips.get(id)?.stop();
    this.microTrips.delete(id);
    // Stage 5: interrupt any active chat session for this NPC
    if (this.chatEngine) {
      const session = this.chatEngine.getSessionFor(id);
      if (session && !session.ended) {
        this.chatEngine.interrupt(session.sessionId, id, Date.now());
        this.endChatVisuals(session);
        const partnerId = session.initiatorId === id ? session.partnerId : session.initiatorId;
        if (worldLifeDebug.states[partnerId] === "CHIT_CHAT") {
          this.applyWorldLifeTransition(partnerId, { name: "chitchat_complete" }, Date.now());
        }
      }
    }
    this.activeBubbles.get(id)?.destroy();
    this.activeBubbles.delete(id);
    this.loungeSignatures.get(id)?.stop();
    this.loungeSignatures.delete(id);
    this.persistedMugs.get(id)?.destroy();
    this.persistedMugs.delete(id);
    this.npcs.delete(id);
    this.npcPaths.delete(id);
    this.npcSeatOffset.delete(id);
    // World-life v2: drop the FSM entry so a later re-spawn starts
    // clean. No-op when the flag is off (worldLifeDebug is empty).
    worldLifeDebug.forget(id);
    this.worldLifeLastToolAt.delete(id);

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

    // Re-derive the label from the live NPC record so any post-spawn
    // updates (e.g. collision-suffix renames in addDynamic) show up
    // here too — otherwise the hover pill drifts away from the
    // right-side roster row.
    const liveDef =
      useNpcStore.getState().dynamic[npcId] ??
      (npc.def as { id: string; name?: string; cwd?: string });
    const expectedLabel = pillLabelFor(liveDef);
    if (code.text !== expectedLabel) code.setText(expectedLabel);

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
        // World-life v2: a real tool event preempts whatever the FSM
        // was doing → ACTIVE_TOOL. Gated by the flag — the call is a
        // no-op when v2 is off.
        this.worldLifeOnToolEvent(agentId);
        this.walkNpcToRoom(agentId, act.room);
        const toolName = eventToolName(act.event);
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
    this.idleAnimCtrl?.tick(this.time.now);
    this.drawTethers();
    this.drawDebugOverlay();
  }

  /** Visual-only push-apart so two NPCs whose sprites end up overlapping
   *  drift a few pixels in opposite directions instead of blending into
   *  a single silhouette. We do NOT touch npc.col/npc.row — the
   *  pathfinder still treats them as occupying their authored cell. */
  private tickSpriteSeparation() {
    const RADIUS = 18; // smaller than a tile (32) on purpose
    const RADIUS_SQ = RADIUS * RADIUS;
    const PUSH_PER_FRAME = 0.6;
    const MAX_OFFSET_SQ = 14 * 14;
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
        const distSq = distX * distX + distY * distY;
        if (distSq >= RADIUS_SQ) continue;
        // Squared-distance early-out keeps the inner loop sqrt-free.
        const dist = Math.sqrt(distSq) || 0.0001;
        // Symmetric push proportional to overlap, normalized inline.
        const factor = (RADIUS - dist) / (RADIUS * dist);
        dx += distX * factor;
        dy += distY * factor;
      }
      if (dx === 0 && dy === 0) continue;
      // Normalize the accumulated push to a fixed step size, capped so
      // two clustered agents drift apart subtly rather than popping.
      const pushSq = dx * dx + dy * dy;
      if (pushSq > 0) {
        const inv = PUSH_PER_FRAME / Math.sqrt(pushSq);
        dx *= inv;
        dy *= inv;
      }
      // Cap total drift from the canonical tile center so a sprite
      // never reads as being in a different tile than npc.col/npc.row.
      const centerX = a.col * TILE_SIZE + TILE_SIZE / 2;
      const centerY = a.row * TILE_SIZE + TILE_SIZE / 2;
      let offX = a.sprite.x + dx - centerX;
      let offY = a.sprite.y + dy - centerY;
      const offSq = offX * offX + offY * offY;
      if (offSq > MAX_OFFSET_SQ) {
        const scale = Math.sqrt(MAX_OFFSET_SQ / offSq);
        offX *= scale;
        offY *= scale;
      }
      const nextX = centerX + offX;
      const nextY = centerY + offY;
      const sepFromX = a.sprite.x;
      const sepFromY = a.sprite.y;
      a.sprite.setPosition(nextX, nextY);
      a.shadow.setPosition(nextX, nextY + 7);
      // Only log meaningful nudges so we don't spam the buffer at
      // 60 fps with sub-pixel jitter.
      const dPx = Math.hypot(nextX - sepFromX, nextY - sepFromY);
      if (dPx > 0.1) {
        logAgent({
          ts: Date.now(),
          scene: this.time.now,
          agentId: aId,
          kind: "separation",
          fromX: sepFromX,
          fromY: sepFromY,
          toX: nextX,
          toY: nextY,
        });
      }
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

    // Seat → desk facing arrows. Yellow line from seat center pointing
    // toward the desk the seated agent will face, with a chevron head.
    const ARROW_LEN = 12;
    const HEAD = 4;
    for (const seat of this.seatCells) {
      const facing = this.deskFacingFor(seat.col, seat.row);
      const sx = seat.px;
      const sy = seat.py;
      const dx = facing === "left" ? -1 : facing === "right" ? 1 : 0;
      const dy = facing === "up" ? -1 : facing === "down" ? 1 : 0;
      const tx = sx + dx * ARROW_LEN;
      const ty = sy + dy * ARROW_LEN;
      gfx.lineStyle(2, 0xffe066, 1);
      gfx.beginPath();
      gfx.moveTo(sx, sy);
      gfx.lineTo(tx, ty);
      gfx.strokePath();
      // Chevron head: two short segments perpendicular to the arrow.
      const px = -dy;
      const py = dx;
      gfx.beginPath();
      gfx.moveTo(tx, ty);
      gfx.lineTo(tx - dx * HEAD + px * HEAD, ty - dy * HEAD + py * HEAD);
      gfx.moveTo(tx, ty);
      gfx.lineTo(tx - dx * HEAD - px * HEAD, ty - dy * HEAD - py * HEAD);
      gfx.strokePath();
      // Small dot at the seat origin for easy visual anchoring.
      gfx.fillStyle(0xffe066, 1);
      gfx.fillCircle(sx, sy, 2);
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
      // badge for vertical space. Clamp to a minimum y so a sub-agent
      // spawned near the top edge of the map doesn't end up with the
      // chip stuck above the camera viewport.
      if (npc.helperBadge) {
        const desiredY = npc.sprite.y - TILE_SIZE - 36;
        const minY = 12;
        npc.helperBadge.setPosition(npc.sprite.x, Math.max(minY, desiredY));
        npc.helperBadge.setDepth(1599 + npc.sprite.y);
      }

      // Decay any expired transient overheads (error flash, prompt
      // flash). Both share the same shape; one branch handles either.
      const now = this.time.now;
      let expired = false;
      if (
        npc.overheadErrorUntil !== undefined &&
        now >= npc.overheadErrorUntil
      ) {
        npc.overheadErrorUntil = undefined;
        expired = true;
      }
      if (
        npc.overheadPromptUntil !== undefined &&
        now >= npc.overheadPromptUntil
      ) {
        npc.overheadPromptUntil = undefined;
        expired = true;
      }
      if (expired) this.renderPill(id);
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

      if (!target) {
        if (npc.transitBadge) {
          npc.transitBadge.destroy();
          npc.transitBadge = undefined;
          npc.transitText = undefined;
        }
        continue;
      }

      // Room labels are stable per RoomId — only re-stringify on a real
      // change to avoid roomById() + template-string allocs every frame.
      const targetKey = `transit:${target}`;
      let text = npc.transitText;
      if (text === undefined || npc.transitText !== targetKey) {
        text = `🚶 → ${roomById(target)?.label ?? target}`;
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
            .setAlpha(0.95);
        } else {
          npc.transitBadge.setText(text);
        }
        // Cache by RoomId so the same target doesn't keep re-rendering.
        npc.transitText = targetKey;
      }
      if (npc.transitBadge) {
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
  /** One-shot bright pulse from parent → newly-spawned sub-agent on
   *  the same path the persistent dashes will follow. Reads as the
   *  moment of delegation: the parent says "go", the helper appears.
   *  Uses a temporary Graphics overlay so it doesn't interfere with
   *  the per-frame `drawTethers` redraw. */
  private flashTetherToParent(childId: string, parentId: string) {
    const child = this.npcs.get(childId);
    const parent = this.npcs.get(parentId);
    if (!child || !parent) return;
    const flash = this.add.graphics().setDepth(951);
    const px = parent.sprite.x;
    const py = parent.sprite.y;
    const cx = child.sprite.x;
    const cy = child.sprite.y;
    flash.lineStyle(3, 0x6ee7b7, 1);
    flash.lineBetween(px, py, cx, cy);
    this.tweens.add({
      targets: flash,
      alpha: { from: 1, to: 0 },
      duration: 500,
      ease: "Quad.easeOut",
      onComplete: () => flash.destroy(),
    });
  }

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
    logAgent({
      ts: Date.now(),
      scene: this.time.now,
      agentId: npcId,
      kind: "summon",
      fromCol: npc.col,
      fromRow: npc.row,
      toCol: anchor.col,
      toRow: anchor.row,
      note: `route to room=${room}`,
    });

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
        logAgent({
          ts: Date.now(),
          scene: this.time.now,
          agentId: id,
          kind: "walk-step-skip",
          fromCol: npc.col,
          fromRow: npc.row,
          toCol: next.col,
          toRow: next.row,
          note: "tile occupied; will retry",
        });
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
      const stepFromX = npc.sprite.x;
      const stepFromY = npc.sprite.y;
      const stepFromCol = npc.col;
      const stepFromRow = npc.row;
      logAgent({
        ts: Date.now(),
        scene: this.time.now,
        agentId: id,
        kind: "walk-step-start",
        fromCol: stepFromCol,
        fromRow: stepFromRow,
        toCol: next.col,
        toRow: next.row,
        fromX: stepFromX,
        fromY: stepFromY,
        toX: targetX,
        toY: targetY,
        note: offset ? `seat-offset px=(${offset.px},${offset.py})` : undefined,
      });
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
          logAgent({
            ts: Date.now(),
            scene: this.time.now,
            agentId: id,
            kind: "walk-step-end",
            fromCol: stepFromCol,
            fromRow: stepFromRow,
            toCol: next.col,
            toRow: next.row,
            toX: npc.sprite.x,
            toY: npc.sprite.y,
          });
          if (offset) {
            // Face the nearest desk so seated agents look at their
            // workstation instead of the last step's incoming axis.
            const facing = this.deskFacingFor(next.col, next.row);
            npc.facing = facing;
            try {
              npc.sprite.stop();
              // Use the idle sheet's first frame in the chosen direction.
              // The dedicated sit sheet is single-direction so it can't
              // express "facing the desk"; the idle sheet has all 4.
              npc.sprite.setTexture(npc.idleAnimKey, IDLE_FRAME[facing][0]);
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

    // Skip the legacy floating-helper sprite when the hook-side linker
    // has already produced a real sub-agent NPC (`metadata.parentId`
    // matches this entity). Otherwise we'd render two visual children
    // for one Task call — the helper sprite plus the real NPC.
    for (const other of this.npcs.values()) {
      if ((other.def as { parentId?: string }).parentId === entity.def.id) {
        return;
      }
    }

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

  // --------------------------------------------------------------------
  // World-life v2 — Stage 1 (spec §2 + §9)
  //
  // The block below adds a 2 Hz state-machine evaluator and a per-NPC
  // structured transition log. ALL of it is gated behind the
  // `worldLifeV2` settings flag; with the flag off, none of this code
  // runs and behaviour is byte-identical to today.
  //
  // Stage 1 only updates per-NPC FSM state + emits log lines. No
  // visual side effects yet — those land in #241/238/237/240/239.
  // --------------------------------------------------------------------

  /** Subscribe to the settings store and start/stop the evaluator
   *  whenever `worldLifeV2` flips. Called once from create(). */
  private subscribeWorldLifeFlag() {
    const start = (on: boolean) => {
      if (on && !this.worldLifeTimer) {
        // 2 Hz tick (spec §2 TICK_HZ). Phaser's TimerEvent uses ms.
        const delay = Math.round(1000 / WORLD_LIFE_TUNABLES.TICK_HZ);
        this.worldLifeTimer = this.time.addEvent({
          delay,
          loop: true,
          callback: () => this.tickWorldLife(),
        });
        // Seed FSM entries for every NPC currently in the scene so
        // the first tick has somewhere to start. Default state is
        // ROOM_IDLE — ACTIVE_TOOL gets set by the next tool event.
        const now = Date.now();
        for (const [id] of this.npcs) {
          worldLifeDebug.ensure(id, "ROOM_IDLE", now);
        }
        // Stage 3: idle micro-animations controller.
        this.idleAnimCtrl = new IdleAnimController(this, {
          spriteFor: (id) => this.npcs.get(id)?.sprite,
          isSeated: (id) => this.seatByNpc.has(id),
          roomFor: (id) => {
            const npc = this.npcs.get(id);
            if (!npc) return null;
            return roomIdForCell(npc.col, npc.row);
          },
          isSuspended: (id) => {
            const npc = this.npcs.get(id);
            if (!npc) return true;
            // Suspended when: walking, has active choreo, in dialog, or selected
            if (this.npcPaths.has(id)) return true;
            if (npc.choreo) return true;
            const state = worldLifeDebug.states[id];
            if (state === "IN_DIALOG" || state === "SUMMONED" || state === "TRAVELING" || state === "ACTIVE_TOOL") return true;
            return false;
          },
        });
        // Seed channels for existing NPCs
        for (const [id] of this.npcs) {
          this.idleAnimCtrl.ensure(id);
        }
        // Stage 4: dwell ladder — tracks how long each NPC has dwelled
        // in one room without tool events, driving micro-trip / break rolls.
        this.dwellTracker = new DwellTracker();
        for (const [id] of this.npcs) {
          this.dwellTracker.ensure(id, Date.now());
        }
        // Stage 5: chit-chat engine
        this.chatEngine = new ChitChatEngine();
      } else if (!on && this.worldLifeTimer) {
        this.worldLifeTimer.destroy();
        this.worldLifeTimer = null;
        this.idleAnimCtrl?.destroy();
        this.idleAnimCtrl = null;
        this.dwellTracker?.destroy();
        this.dwellTracker = null;
        for (const h of this.microTrips.values()) h.stop();
        this.microTrips.clear();
        // Stage 5: destroy chat engine + bubbles + timers
        this.chatEngine?.destroy();
        this.chatEngine = null;
        for (const b of this.activeBubbles.values()) b.destroy();
        this.activeBubbles.clear();
        for (const t of this.chatAdvanceTimers.values()) t.remove(false);
        this.chatAdvanceTimers.clear();
      }
    };
    start(useSettingsStore.getState().worldLifeV2);
    const onCalm = (calm: boolean) => this.handleCalmModeChange(calm);
    this.unsubscribeSettings = useSettingsStore.subscribe(
      (state, prev) => {
        if (state.worldLifeV2 !== prev.worldLifeV2) start(state.worldLifeV2);
        if (state.calmMode !== prev.calmMode) onCalm(state.calmMode);
      },
    );
  }

  /** Called when the settings store's `calmMode` flag changes.
   *  When calm mode turns ON all decorative world-life visuals stop
   *  (idle anims, lounge signatures, micro-trips, chit-chat bubbles).
   *  The FSM + real tool events keep working.
   *  When calm mode turns OFF, idle-anims are re-initialized. */
  private handleCalmModeChange(calm: boolean) {
    if (calm) {
      // Freeze everything decorative
      this.idleAnimCtrl?.destroy();
      this.idleAnimCtrl = null;
      for (const h of this.loungeSignatures.values()) h.stop();
      this.loungeSignatures.clear();
      for (const h of this.persistedMugs.values()) h.destroy();
      this.persistedMugs.clear();
      for (const h of this.microTrips.values()) h.stop();
      this.microTrips.clear();
      // End all chats gracefully
      if (this.chatEngine) {
        for (const session of this.chatEngine.getActiveSessions()) {
          this.chatEngine.endSession(session.sessionId, Date.now());
        }
      }
      for (const b of this.activeBubbles.values()) b.destroy();
      this.activeBubbles.clear();
      for (const t of this.chatAdvanceTimers.values()) t.remove(false);
      this.chatAdvanceTimers.clear();
    } else {
      // Re-initialize idle anims if worldLifeV2 is on
      if (this.worldLifeTimer && !this.idleAnimCtrl) {
        this.idleAnimCtrl = new IdleAnimController(this, {
          spriteFor: (id) => this.npcs.get(id)?.sprite,
          isSeated: (id) => this.seatByNpc.has(id),
          roomFor: (id) => {
            const npc = this.npcs.get(id);
            if (!npc) return null;
            return roomIdForCell(npc.col, npc.row);
          },
          isSuspended: (id) => {
            const npc = this.npcs.get(id);
            if (!npc) return true;
            if (this.npcPaths.has(id)) return true;
            if (npc.choreo) return true;
            const state = worldLifeDebug.states[id];
            if (state === "IN_DIALOG" || state === "SUMMONED" || state === "TRAVELING" || state === "ACTIVE_TOOL") return true;
            return false;
          },
        });
        for (const [id] of this.npcs) {
          this.idleAnimCtrl.ensure(id);
        }
      }
    }
  }

  /** Hook called from subscribeStores when an NPC's `activities[id].version`
   *  increments (real tool/state event). When the timer is running we
   *  drive the FSM into ACTIVE_TOOL via the standard transition path.
   *  We use the timer (not the flag) as the single source of truth so
   *  the flag is checked exactly once — when the timer is created in
   *  subscribeWorldLifeFlag. */
  private worldLifeOnToolEvent(agentId: string) {
    if (!this.worldLifeTimer) return;
    const now = Date.now();
    this.worldLifeLastToolAt.set(agentId, now);
    worldLifeDebug.ensure(agentId, "ROOM_IDLE", now);
    this.applyWorldLifeTransition(agentId, { name: "tool_event" }, now);

    // Dwell ladder: bump-back on same-room tool event.
    if (this.dwellTracker) {
      // Treat all tool events as same-room since room changes happen via
      // walkNpcToRoom which isn't tied to tool events.
      this.dwellTracker.onToolEvent(agentId, true, now);
    }

    // Preempt any in-flight micro-trip on tool event.
    const tripHandle = this.microTrips.get(agentId);
    if (tripHandle) {
      tripHandle.stop();
      this.microTrips.delete(agentId);
    }

    // Stage 5: interrupt any active chat session on tool event.
    if (this.chatEngine) {
      const session = this.chatEngine.getSessionFor(agentId);
      if (session && !session.ended) {
        this.chatEngine.interrupt(session.sessionId, agentId, now);
        // Show farewell wave on partner
        const partnerId = session.initiatorId === agentId ? session.partnerId : session.initiatorId;
        this.showFarewellBubble(partnerId);
        this.endChatVisuals(session);
        // Transition partner back to ROOM_IDLE
        if (worldLifeDebug.states[partnerId] === "CHIT_CHAT") {
          this.applyWorldLifeTransition(partnerId, { name: "chitchat_complete" }, now);
        }
      }
    }
  }

  /** 2 Hz evaluator. Walks every NPC and feeds the relevant
   *  per-state trigger into nextState(). Handles:
   *  - ACTIVE_TOOL → ROOM_IDLE (after TOOL_QUIET_S)
   *  - ROOM_IDLE → ROOM_SIGNATURE (signature_roll in lounge)
   *  - ROOM_SIGNATURE → ROOM_IDLE (signature_complete)
   *
   *  No flag check here — the timer is only created when the flag is
   *  on (see subscribeWorldLifeFlag), so the timer's existence is the
   *  single source of truth. */
  private tickWorldLife() {
    const now = Date.now();
    const calm = useSettingsStore.getState().calmMode;
    for (const [id, npc] of this.npcs) {
      worldLifeDebug.ensure(id, "ROOM_IDLE", now);
      const cur = worldLifeDebug.states[id];

      if (cur === "ACTIVE_TOOL") {
        // --- Stage 1: tool quiet → ROOM_IDLE ---
        const lastTool = this.worldLifeLastToolAt.get(id) ?? 0;
        const quietS = (now - lastTool) / 1000;
        if (quietS >= WORLD_LIFE_TUNABLES.TOOL_QUIET_S) {
          this.applyWorldLifeTransition(
            id,
            { name: "tool_quiet_elapsed", dwellS: quietS },
            now,
          );
        }
        // Tool event also preempts an in-flight signature
        const sigHandle = this.loungeSignatures.get(id);
        if (sigHandle) {
          sigHandle.stop();
          this.loungeSignatures.delete(id);
        }
        // Hard-kill any persisted mug on tool preemption (spec §4 rule 4)
        const mugHandle = this.persistedMugs.get(id);
        if (mugHandle) {
          mugHandle.destroy();
          this.persistedMugs.delete(id);
        }
      } else if (cur === "ROOM_IDLE") {
        const room = roomIdForCell(npc.col, npc.row);

        if (!calm) {
          // --- Stage 2: signature roll (lounge only) ---
          if (room === "lounge") {
            // If NPC returned to lounge, cancel any persisted mug decay timer
            const existingMug = this.persistedMugs.get(id);
            if (existingMug) {
              existingMug.cancelDecay();
              this.persistedMugs.delete(id);
            }

            const enteredAt = worldLifeDebug.enteredAt[id] ?? now;
            const dwellS = (now - enteredAt) / 1000;
            if (dwellS >= WORLD_LIFE_TUNABLES.SIG_MIN_S) {
              const cd = worldLifeDebug.cooldowns[id];
              const { ready } = cd ? sigCooldown(cd, "lounge", now) : { ready: true };
              if (ready) {
                const roll = Math.random();
                const threshold = WORLD_LIFE_TUNABLES.SIG_PROB;
                if (roll < threshold) {
                  this.applyWorldLifeTransition(
                    id,
                    { name: "signature_roll", dwellS, roll, threshold },
                    now,
                  );
                  // Set cooldown
                  if (cd) setSigCooldown(cd, "lounge", now);
                  // Start the visual
                  this.startLoungeSignatureFor(id, npc);
                }
              }
            }
          }

          // --- Dwell ladder: micro-trip rolls (S3/S4/S5) ---
          if (this.dwellTracker && room !== "lounge") {
            const dwell = this.dwellTracker.ensure(id, now);

            if (dwell.stage === "S3" || dwell.stage === "S4" || dwell.stage === "S5") {
              // S3: micro-trip at raised probability
              // S4: break (longer trip to lounge)
              // S5: alternate trip/break
              const isBreak = dwell.stage === "S4" ||
                (dwell.stage === "S5" && this.dwellTracker.nextS5Sub(id) === "break");

              if (isBreak) {
                // Check break anti-patterns
                const lastTool = this.worldLifeLastToolAt.get(id) ?? 0;
                if (this.dwellTracker.canBreak(id, lastTool, now)) {
                  const roll = Math.random();
                  const threshold = WORLD_LIFE_TUNABLES.MICRO_PROB * 3;
                  if (roll < threshold) {
                    this.applyWorldLifeTransition(
                      id,
                      { name: "microtrip_roll", dwellS: (now - (worldLifeDebug.enteredAt[id] ?? now)) / 1000, roll, threshold },
                      now,
                    );
                    this.startMicroTripFor(id, npc, { isBreak: true });
                    this.dwellTracker.recordBreak(id, now);
                    if (dwell.stage === "S5") this.dwellTracker.recordS5Sub(id, "break");
                  }
                }
              } else {
                // Regular micro-trip
                if (this.dwellTracker.canMicroTrip(id, now)) {
                  const cd = worldLifeDebug.cooldowns[id] ?? makeCooldowns();
                  const { ready } = microCooldown(cd, now);
                  if (ready) {
                    const roll = Math.random();
                    const threshold = 0.60; // raised per spec in S3+ window
                    if (roll < threshold) {
                      this.applyWorldLifeTransition(
                        id,
                        { name: "microtrip_roll", dwellS: (now - (worldLifeDebug.enteredAt[id] ?? now)) / 1000, roll, threshold },
                        now,
                      );
                      this.startMicroTripFor(id, npc, { isBreak: false });
                      setMicroCooldown(cd, now);
                      this.dwellTracker.recordMicroTrip(id, now);
                      if (dwell.stage === "S5") this.dwellTracker.recordS5Sub(id, "trip");
                    }
                  }
                }
              }
            }
          }

          // --- Stage 5: chit-chat roll ---
          if (this.chatEngine && !this.chatEngine.isAtGlobalCap()) {
            const chatRoom = roomIdForCell(npc.col, npc.row);
            if (chatRoom) {
              const chatProb = chatProbForRoom(chatRoom);
              if (chatProb > 0 && this.chatEngine.canChat(id, now)) {
                for (const [otherId, otherNpc] of this.npcs) {
                  if (otherId === id) continue;
                  const otherState = worldLifeDebug.states[otherId];
                  if (otherState !== "ROOM_IDLE") continue;
                  const otherRoom = roomIdForCell(otherNpc.col, otherNpc.row);
                  if (otherRoom !== chatRoom) continue;
                  if (!this.chatEngine.canChat(otherId, now)) continue;
                  // Proximity check: <= 120 px
                  const dx = npc.sprite.x - otherNpc.sprite.x;
                  const dy = npc.sprite.y - otherNpc.sprite.y;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  if (dist > 120) continue;
                  // Both roll against chatProb
                  const roll = Math.random();
                  if (roll >= chatProb) continue;
                  const partnerRoll = Math.random();
                  if (partnerRoll >= chatProb) continue;
                  // Start the chat!
                  const mood = this.getAgentMood(id);
                  const session = this.chatEngine.tryStartChat(id, otherId, mood, now);
                  if (!session) continue;
                  // Transition both to CHIT_CHAT
                  this.applyWorldLifeTransition(id, { name: "chitchat_roll", hasChatPartner: true, roll, threshold: chatProb }, now);
                  this.applyWorldLifeTransition(otherId, { name: "chitchat_roll", hasChatPartner: true, roll: partnerRoll, threshold: chatProb }, now);
                  // Start the visual exchange sequence
                  this.startChatExchange(session);
                  break; // only start one chat per tick per NPC
                }
              }
            }
          }
        }
      } else if (cur === "ROOM_SIGNATURE") {
        // --- Stage 2: tick in-flight signature, complete when done ---
        const sigHandle = this.loungeSignatures.get(id);
        if (sigHandle && sigHandle.done) {
          this.loungeSignatures.delete(id);
          this.applyWorldLifeTransition(
            id,
            { name: "signature_complete" },
            now,
          );
        }
        // If the NPC has left the lounge (e.g. walked away), soft-stop
        const room = roomIdForCell(npc.col, npc.row);
        if (room !== "lounge" && sigHandle && !sigHandle.done) {
          const mugPersist = sigHandle.softStop();
          this.loungeSignatures.delete(id);
          if (mugPersist) {
            this.persistedMugs.set(id, mugPersist);
          }
          this.applyWorldLifeTransition(
            id,
            { name: "signature_complete" },
            now,
          );
        }
      } else if (cur === "MICRO_TRIP") {
        // --- Stage 4: tick in-flight micro-trip, complete when done ---
        const tripHandle = this.microTrips.get(id);
        if (tripHandle && tripHandle.done) {
          this.microTrips.delete(id);
          this.applyWorldLifeTransition(id, { name: "microtrip_complete" }, now);
          if (this.dwellTracker) {
            this.dwellTracker.recordMicroTrip(id, now);
          }
        }
      } else if (cur === "CHIT_CHAT") {
        // --- Stage 5: hard kill (16s wall-clock cap) ---
        const session = this.chatEngine?.getSessionFor(id);
        if (session && !session.ended && (now - session.startMs > 16000)) {
          this.chatEngine?.endSession(session.sessionId, now);
          this.endChatVisuals(session);
          this.applyWorldLifeTransition(id, { name: "chitchat_complete" }, now);
          // Also transition partner
          const partnerId = session.initiatorId === id ? session.partnerId : session.initiatorId;
          if (worldLifeDebug.states[partnerId] === "CHIT_CHAT") {
            this.applyWorldLifeTransition(partnerId, { name: "chitchat_complete" }, now);
          }
        }
      }
    }
    // FSM entries for despawned NPCs are removed in removeNpcEntity —
    // no stale-sweep needed here.
  }

  /** Start the lounge signature visual for an NPC. Creates walkTo
   *  callbacks that bridge back into the scene's pathfinding. */
  private startLoungeSignatureFor(
    npcId: string,
    npc: Entity & { def: NpcDef; tween?: Phaser.Tweens.Tween },
  ) {
    // Resolve the lounge anchor
    const anchor = ROOM_ANCHORS["lounge"];
    if (!anchor) return;

    // walkTo callback: uses walkNpcToCell + returns a Promise that
    // resolves when the path drains.
    const walkTo = (col: number, row: number): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        const entity = this.npcs.get(npcId);
        if (!entity) { reject(); return; }
        // If already at target, resolve immediately
        if (entity.col === col && entity.row === row) { resolve(); return; }
        this.walkNpcToCell(npcId, col, row);
        // Poll for arrival (path drains) — check every step duration
        const check = this.time.addEvent({
          delay: STEP_DURATION_MS,
          loop: true,
          callback: () => {
            const e = this.npcs.get(npcId);
            if (!e) { check.remove(false); reject(); return; }
            const path = this.npcPaths.get(npcId);
            if (!path || path.length === 0) {
              check.remove(false);
              resolve();
            }
          },
        });
      });
    };

    const getPos = () => {
      const e = this.npcs.get(npcId);
      return e ? { col: e.col, row: e.row } : { col: anchor.col, row: anchor.row };
    };

    const handle = startLoungeSignature(
      this,
      npc.sprite,
      anchor.col,
      anchor.row,
      { walkTo, getPos },
    );
    this.loungeSignatures.set(npcId, handle);
  }

  /** Start a micro-trip (or break) for an NPC. Bridges the scene's
   *  pathfinding/position into the micro-trip visual module. */
  private startMicroTripFor(
    npcId: string,
    npc: Entity & { def: NpcDef; tween?: Phaser.Tweens.Tween },
    options: { isBreak: boolean },
  ) {
    const walkTo = (col: number, row: number): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        const entity = this.npcs.get(npcId);
        if (!entity) { reject(); return; }
        if (entity.col === col && entity.row === row) { resolve(); return; }
        this.walkNpcToCell(npcId, col, row);
        const check = this.time.addEvent({
          delay: STEP_DURATION_MS,
          loop: true,
          callback: () => {
            const e = this.npcs.get(npcId);
            if (!e) { check.remove(false); reject(); return; }
            const path = this.npcPaths.get(npcId);
            if (!path || path.length === 0) {
              check.remove(false);
              resolve();
            }
          },
        });
      });
    };

    const getPos = () => {
      const e = this.npcs.get(npcId);
      return e ? { col: e.col, row: e.row } : { col: 0, row: 0 };
    };

    const getHomeSeat = () => {
      const seat = this.seatByNpc.get(npcId);
      return seat ? { col: seat.col, row: seat.row } : getPos();
    };

    const getAdjacentRooms = () => {
      const currentRoom = roomIdForCell(npc.col, npc.row);
      if (!currentRoom) return [];
      const regions = getRoomRegions();
      const current = regions.find(r => r.id === currentRoom);
      if (!current) return [];
      // Adjacency: rooms whose bounds are within 3 tiles of the current room's bounds
      const ADJ_THRESHOLD = 3;
      return regions
        .filter(r => {
          if (r.id === currentRoom) return false;
          const hGap = Math.max(0, r.colMin - current.colMax - 1, current.colMin - r.colMax - 1);
          const vGap = Math.max(0, r.rowMin - current.rowMax - 1, current.rowMin - r.rowMax - 1);
          return hGap <= ADJ_THRESHOLD && vGap <= ADJ_THRESHOLD;
        })
        .map(r => {
          const anchor = ROOM_ANCHORS[r.id];
          return anchor ? { roomId: r.id as string, col: anchor.col, row: anchor.row } : null;
        })
        .filter((x): x is { roomId: string; col: number; row: number } => x !== null);
    };

    const tripHandle = startMicroTrip(this, npc.sprite, { walkTo, getPos, getHomeSeat, getAdjacentRooms }, options);
    this.microTrips.set(npcId, tripHandle);
  }

  // ------------------------------------------------------------------
  // Stage 5: chit-chat helper methods
  // ------------------------------------------------------------------

  private getAgentMood(_npcId: string): AgentMood {
    // Check recent activity — if last tool event was an error, mood is "recent-error"
    // For now, default to "neutral" — can be enhanced with activity store data
    return "neutral";
  }

  private startChatExchange(session: ChatSession) {
    // Advance immediately for first exchange (greeting)
    this.advanceChatBubble(session);
  }

  private advanceChatBubble(session: ChatSession) {
    if (session.ended || !this.chatEngine) return;
    const result = this.chatEngine.advance(session.sessionId, Date.now());
    if (!result) {
      // Session ended (farewell was played)
      this.endChatVisuals(session);
      const now = Date.now();
      this.applyWorldLifeTransition(session.initiatorId, { name: "chitchat_complete" }, now);
      if (worldLifeDebug.states[session.partnerId] === "CHIT_CHAT") {
        this.applyWorldLifeTransition(session.partnerId, { name: "chitchat_complete" }, now);
      }
      return;
    }

    // Show bubble for the speaker
    const speakerId = result.speaker === "both" ? session.initiatorId : result.speaker;
    const npc = this.npcs.get(speakerId);
    const partnerId = speakerId === session.initiatorId ? session.partnerId : session.initiatorId;
    const partner = this.npcs.get(partnerId);

    if (npc && partner) {
      // Destroy any existing bubble for this speaker
      this.activeBubbles.get(speakerId)?.destroy();
      const side = bubbleSide(npc.sprite.x, partner.sprite.x);
      const handle = showChatBubble(this, { emoji: result.emoji, sprite: npc.sprite, side });
      this.activeBubbles.set(speakerId, handle);

      // If "both", also show on partner
      if (result.speaker === "both") {
        this.activeBubbles.get(partnerId)?.destroy();
        const partnerSide = bubbleSide(partner.sprite.x, npc.sprite.x);
        const partnerHandle = showChatBubble(this, { emoji: result.emoji, sprite: partner.sprite, side: partnerSide });
        this.activeBubbles.set(partnerId, partnerHandle);
      }
    }

    // Schedule next advance after bubble cycle (350 + 1800 + 250 + 400 gap = 2800ms)
    const timer = this.time.delayedCall(2800, () => {
      this.chatAdvanceTimers.delete(session.sessionId);
      this.advanceChatBubble(session);
    });
    this.chatAdvanceTimers.set(session.sessionId, timer);
  }

  private showFarewellBubble(npcId: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    this.activeBubbles.get(npcId)?.destroy();
    const handle = showChatBubble(this, { emoji: "\u{1F44B}", sprite: npc.sprite, side: "right" });
    this.activeBubbles.set(npcId, handle);
  }

  private endChatVisuals(session: ChatSession) {
    // Kill advance timer
    const timer = this.chatAdvanceTimers.get(session.sessionId);
    if (timer) { timer.remove(false); this.chatAdvanceTimers.delete(session.sessionId); }
    // Let active bubbles finish their fade-out naturally (don't yank per spec)
    // They'll auto-destroy after their cycle
  }

  /** Run the pure transition, and if it changed the state, push a ring
   *  buffer entry and emit the structured log line (spec §9). */
  private applyWorldLifeTransition(
    npcId: string,
    trigger: WorldLifeTrigger,
    nowMs: number,
  ) {
    const from: WorldLifeState = worldLifeDebug.states[npcId] ?? "ROOM_IDLE";
    const enteredAt = worldLifeDebug.enteredAt[npcId] ?? nowMs;
    const dwellS = Math.max(0, (nowMs - enteredAt) / 1000);
    const to = worldLifeNextState(from, trigger);
    if (to === from) return;
    const cd = worldLifeDebug.cooldowns[npcId];
    const cooldownsS = cd
      ? snapshotCooldownsS(cd, nowMs)
      : { sig: 0, micro: 0, chat: 0 };
    // Pull roll/threshold out of *_roll triggers so the structured log
    // line can show the values that drove the transition. Other
    // variants don't carry these fields.
    const rollPayload =
      trigger.name === "signature_roll" ||
      trigger.name === "microtrip_roll" ||
      trigger.name === "chitchat_roll"
        ? { roll: trigger.roll, threshold: trigger.threshold }
        : {};
    const entry = {
      ts: nowMs,
      npcId,
      from,
      to,
      trigger: trigger.name,
      dwellS,
      cooldownsS,
      ...rollPayload,
    };
    worldLifeDebug.record(entry);
    // Single structured log line per spec §9. Emitted at info so a
    // grep over devtools console answers "why didn't she go get
    // coffee?" in one line per transition.
    if (typeof console !== "undefined") {
      console.info(formatTransitionLog(entry));
    }
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
