import Phaser from "phaser";
import type { AgentEvent, AnimationId, RoomId } from "../events/types";
import {
  emojiForActivity,
  ERROR_EMOJI,
  IDLE_EMOJI,
} from "../events/stateToRoom";
import { useAgentStore } from "../stores/useAgentStore";
import { useGameStore } from "../stores/useGameStore";
import { buildLiveGreeting, useNpcStore } from "../stores/useNpcStore";
import { useWorldBus } from "../stores/useWorldBus";
import { GB, TILE_SIZE } from "./palette";
import { type NpcDef } from "./npcs";
import { bfs } from "./pathfind";
import {
  buildCharacterSheetFromTile,
  DEFAULT_CHARACTER_TILE,
} from "./pixelArt";
import { ROOM_ANCHORS } from "./rooms";
import {
  EXTERIOR_ANCHORS,
  isWalkableIn,
  loadInteriorZone,
  type ZoneDef,
} from "./zones";
import { resolveGid } from "./tiled-loader";
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
const NPC_KEY = (id: string) => `gb_npc_${id}`;

const STEP_DURATION_MS = 160;

// Frame indices (matches pixelArt CHAR_FRAME order)
const FRAME = {
  down: [0, 1],
  up: [2, 3],
  left: [4, 5],
  right: [6, 7],
} as const;

// Camera control constants (v2.0 free-pan mode).
const DRAG_THRESHOLD_PX = 4;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/** 4-char uppercase code used in the always-on overhead pill. Prefers the
 *  NPC's dynamic name suffix (e.g. "Claude-A4" → "A4"); falls back to the
 *  last 4 chars of the id so the code is still stable. */
function shortCodeFor(id: string): string {
  const tail = id.replace(/[^A-Za-z0-9]/g, "").slice(-4);
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
  col: number;
  row: number;
  facing: Direction;
  animKey: string; // prefix used for this entity's anims
  // Baseline sprite scale between choreos. 1 for normal NPCs, 0.8 for
  // sub-agents so they read as smaller/subordinate even at rest. Choreo
  // startChoreoFor/stop must respect this to avoid snapping back to 1.
  restingScale: number;
  // Active per-tool choreography (set by subscribeStores on activity events).
  choreo?: { kind: ChoreoKind; handle: ChoreoHandle; startedAt: number };
  // Helper sprite spawned while the agent is running a `Task` (sub-agent).
  helper?: HelperSprite;
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

  // Graphics object used to draw tether lines between parent NPCs and their
  // sub-agent children. Redrawn every frame inside `update()`.
  private tetherGfx!: Phaser.GameObjects.Graphics;

  // Cinema loop — idle NPCs head to the Cinema and sit on a seat.
  // Replaced the old wanderTick (which moved NPCs to random rooms for no
  // reason). NPCs now only move for real activity OR to/from the cinema.
  private cinemaTimer: Phaser.Time.TimerEvent | null = null;
  // Last time an NPC did something real (tool activity or summon). Used to
  // gate the cinema loop — we only send them to the cinema after a quiet
  // window, so we don't yank a just-walked NPC back.
  private lastActivityAt = new Map<string, number>();
  // Claimed cinema seats: npcId -> seat key. A seat key is "col,row".
  private occupiedSeats = new Map<string, string>();
  // Inverse lookup so we can release a seat without scanning.
  private seatByNpc = new Map<string, { col: number; row: number }>();
  // Counter-state for each summon tick so we only act on increments.
  private lastSeenSummonTicks: Record<string, number> = {};

  constructor() {
    super("WorldScene");
  }

  preload() {
    // Kenney Tiny Dungeon tilesheet — source for procedural character
    // sprites. Frame size is 16x16 (Kenney native), independent of the
    // world TILE_SIZE; we scale NPC sprites at render time.
    this.load.spritesheet(TILESET_KEY, "/assets/tilesets/tiny-dungeon.png", {
      frameWidth: 16,
      frameHeight: 16,
    });
  }

  /**
   * Build (or reuse) a per-entity character spritesheet by synthesizing an
   * 8-frame walk sheet from a single character tile in the Tiny Dungeon
   * tilemap, then palette-swapping the shirt colors with the entity's tint.
   * Must run after the tileset image has finished loading (inside create()).
   */
  private ensureCharacterTexture(
    key: string,
    baseTile: number,
    tint: { l?: string; L?: string; d?: string },
  ) {
    if (this.textures.exists(key)) return;
    const tilemap = this.textures
      .get(TILESET_KEY)
      .getSourceImage() as HTMLImageElement;
    const canvas = buildCharacterSheetFromTile(tilemap, baseTile, tint);
    // Character sheet is 8 frames × 16x16 native pixels (Kenney). The
    // world's TILE_SIZE is 32 — sprites are scaled up at render time
    // to match the new tile cadence.
    this.textures.addSpriteSheet(
      key,
      canvas as unknown as HTMLImageElement,
      { frameWidth: 16, frameHeight: 16 },
    );
  }

  private ensureNpcTexture(npc: NpcDef) {
    this.ensureCharacterTexture(
      NPC_KEY(npc.id),
      npc.baseTile ?? DEFAULT_CHARACTER_TILE,
      npc.tint,
    );
  }

  async create() {
    // Stop the canvas from ever showing the browser's native right-click
    // menu. We handle right-click entirely in React (see GameCanvasInner).
    this.input.mouse?.disableContextMenu();
    this.cameras.main.setBackgroundColor(GB.lightest);
    this.cameras.main.roundPixels = true;

    // Async-load the Tiled `.tmj`, queue its tileset PNGs into Phaser's
    // loader, kick off a second load pass, then render once everything
    // is in memory. Phaser supports nested loads as long as we wait on
    // the LOADER_COMPLETE event.
    const bundle = await loadInteriorZone();
    this.zone = bundle.zone;

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

    // Camera bounds with a full-map-size pad on each side so the
    // building can always be centered no matter the viewport.
    const mapW = this.zone.cols * TILE_SIZE;
    const mapH = this.zone.rows * TILE_SIZE;
    const pad = Math.max(mapW, mapH);
    this.cameras.main.setBounds(-pad, -pad, mapW + pad * 2, mapH + pad * 2);

    for (const npc of useNpcStore.getState().staticNpcs) {
      this.ensureNpcTexture(npc);
    }

    this.drawMap();
    this.drawRoomLabels();
    this.createAnims();
    this.createNpcs();
    this.setupMouseInput();
    this.subscribeStores();
    this.startCinemaLoop();

    // Tether rendering layer — sits under sprites so it doesn't obscure them.
    this.tetherGfx = this.add.graphics().setDepth(950);

    // Center the camera on the factory floor's geometric middle. Re-run
    // this whenever the canvas resizes AS LONG AS the user hasn't moved
    // the camera yet — once they've panned or zoomed, we respect their
    // position and stop auto-centering.
    const cam = this.cameras.main;
    cam.setZoom(1);
    const recenter = () => {
      if (this.hasUserMovedCamera) return;
      cam.centerOn(mapW / 2, mapH / 2);
    };
    recenter();
    this.scale.on("resize", recenter);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", recenter);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribeAgents?.();
      this.unsubscribeGame?.();
      this.unsubDialogActive?.();
      this.unsubscribeAgents = null;
      this.unsubscribeGame = null;
      this.cinemaTimer?.destroy();
      this.cinemaTimer = null;
      // Clear all scene-local state. scene.restart() reuses the same
      // instance so class-field maps persist across restarts — an old
      // walk path targeting a now-destroyed sprite crashes tickNpcPaths.
      this.npcPaths.clear();
      this.npcs.clear();
      this.occupiedSeats.clear();
      this.seatByNpc.clear();
      this.lastActivityAt.clear();
    });
  }

  // --------------------------------------------------------------------
  // Cinema loop — idle NPCs head down to the Cinema room and sit on a seat
  // until summoned or until a real activity arrives. Replaces the old
  // random-wander loop so NPCs only move for a concrete reason.
  // --------------------------------------------------------------------

  // The set of walkable tiles representing cinema seats. Kept in seats[] as
  // "col,row" keys; matches the RUG tiles placed in src/game/zones.ts at
  // rows 18/19, cols 4/7/16/19.
  private static readonly CINEMA_SEATS: Array<{ col: number; row: number }> = [
    { col: 4, row: 18 },
    { col: 7, row: 18 },
    { col: 16, row: 18 },
    { col: 19, row: 18 },
    { col: 4, row: 19 },
    { col: 7, row: 19 },
    { col: 16, row: 19 },
    { col: 19, row: 19 },
  ];

  private startCinemaLoop() {
    if (this.zone.id !== "interior") return;
    this.cinemaTimer = this.time.addEvent({
      delay: 2000,
      loop: true,
      callback: () => this.cinemaTick(),
    });
  }

  private cinemaTick() {
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

      this.walkNpcToCell(npc.def.id, seat.col, seat.row);
      // Record an activity timestamp at the cinema-departure moment so the
      // loop doesn't immediately re-fire for the next NPC on the same tick
      // that happens to land on the same quiet threshold.
      if (!this.lastActivityAt.has(npc.def.id)) {
        this.lastActivityAt.set(npc.def.id, now);
      }
    }
  }

  private claimFreeSeat(
    npcId: string,
  ): { col: number; row: number } | null {
    for (const seat of WorldScene.CINEMA_SEATS) {
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
   */
  private walkNpcToCell(npcId: string, targetCol: number, targetRow: number) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;

    const blocked: Array<{ col: number; row: number }> = [];
    for (const other of this.npcs.values()) {
      if (other.def.id === npcId) continue;
      blocked.push({ col: other.col, row: other.row });
    }
    const path = bfs(npc.col, npc.row, targetCol, targetRow, { blocked });
    if (path.length <= 1) return;
    this.npcPaths.set(npcId, path.slice(1));
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

  private drawRoomLabels() {
    // Room labels are rendered in the React HUD overlay, not inside the canvas.
    // In-canvas tiny pixel text is unreadable at most zoom levels.
  }

  // --------------------------------------------------------------------
  // animation setup — per-entity anim keys so they don't fight
  // --------------------------------------------------------------------
  private createAnims() {
    for (const npc of useNpcStore.getState().staticNpcs) {
      this.ensureAnimsFor(npc.id, NPC_KEY(npc.id));
    }
  }

  private ensureAnimsFor(prefix: string, sheetKey: string) {
    for (const dir of ["down", "up", "left", "right"] as Direction[]) {
      const frames = FRAME[dir];
      const animKey = `${prefix}-walk-${dir}`;
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
    this.ensureAnimsFor(def.id, NPC_KEY(def.id));

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
    const sprite = this.add
      .sprite(px, py, NPC_KEY(def.id), 0)
      .setDepth(1000 + row);

    const indicator = this.add
      .text(px, py - 14, "!", {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: "8px",
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
      .text(0, 0, shortCodeFor(def.id), {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: "7px",
        color: "#1b1e2b",
        resolution: 3,
      })
      .setOrigin(0, 0.5);
    const overheadEmojiText = this.add
      .text(0, 0, IDLE_EMOJI, {
        fontFamily:
          '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
        fontSize: "10px",
        color: "#1b1e2b",
        resolution: 3,
      })
      .setOrigin(0, 0.5);
    const overheadContainer = this.add
      .container(px, py - 18, [overheadBg, overheadCodeText, overheadEmojiText])
      .setDepth(1600 + row)
      .setAlpha(1);

    // Sub-agents (those with a parentId) render at 80% scale so they read
    // as visibly subordinate to their parent NPC. The spawn pop starts from
    // that reduced target scale rather than 1.
    const isSubAgent = Boolean(
      (def as { parentId?: string }).parentId,
    );
    // World tiles are 32px; Kenney character sprites are 16px native.
    // Default scale is 2 so a sprite occupies a full tile. Sub-agents
    // shrink to 1.6 (was 0.8 in 16px-tile world) to read as smaller.
    const restingScale = isSubAgent ? 1.6 : 2;

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
      animKey: def.id,
      restingScale,
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
      },
    });

    // Replay any pending activity that arrived BEFORE we had a sprite to
    // animate. Without this, a `tool Bash` event that lands in the 0-5ms
    // between addDynamic() and the scene's useNpcStore.subscribe firing
    // gets silently dropped at subscribeStores' `this.npcs.get(id)` check
    // — the NPC spawns and then just sits there.
    const pending = useAgentStore.getState().activities[def.id];
    if (pending) {
      this.lastActivityAt.set(def.id, this.time.now);
      this.walkNpcToRoom(def.id, pending.room);
      const pathLen = this.npcPaths.get(def.id)?.length ?? 0;
      this.time.delayedCall(pathLen * STEP_DURATION_MS + 40, () => {
        const live = this.npcs.get(def.id);
        if (!live) return;
        this.startChoreoFor(live, pending.choreo);
        this.updateOverheadPill(
          def.id,
          (pending.event.metadata as { toolName?: string } | undefined)
            ?.toolName,
          pending.event.state,
          false,
        );
      });
    } else if (isDynamic && !parentId) {
      // No pending activity — still walk from the exterior entry to the
      // spawn cell so the arrival reads naturally. Target is the home
      // cell the NPC *would* have spawned at without walk-in.
      this.walkNpcToCell(def.id, targetCol, targetRow);
    }
  }

  removeNpcEntity(id: string) {
    const npc = this.npcs.get(id);
    if (!npc) return;

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
      npc.overheadErrorUntil = this.time.now + 800;
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

    const showError =
      npc.overheadErrorUntil !== undefined &&
      this.time.now < npc.overheadErrorUntil;
    const activeEmoji = showError
      ? ERROR_EMOJI
      : npc.overheadBaselineEmoji ?? IDLE_EMOJI;
    emoji.setText(activeEmoji);

    // Lay out: [padding code · padding emoji padding]
    const PAD_X = 4;
    const GAP = 4;
    const codeW = code.width;
    const emojiW = emoji.width;
    const innerW = codeW + GAP + emojiW;
    const w = innerW + PAD_X * 2;
    const h = Math.max(code.height, emoji.height) + 4;
    code.setPosition(-w / 2 + PAD_X, 0);
    emoji.setPosition(-w / 2 + PAD_X + codeW + GAP, 0);

    const bg = npc.overheadBg;
    bg.clear();
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
        const nextZoom = Math.max(
          ZOOM_MIN,
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
    this.tickOverheadPills();
    this.drawTethers();
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

      if (
        npc.overheadErrorUntil !== undefined &&
        this.time.now >= npc.overheadErrorUntil
      ) {
        npc.overheadErrorUntil = undefined;
        this.renderPill(id);
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
      this.tetherGfx.lineStyle(1, 0x0f380f, 0.45);
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
    if (
      !this.isWalkableHere(target.col, target.row) ||
      this.isEntityAt(target.col, target.row, npcId)
    ) {
      const candidates = [
        [anchor.col + 1, anchor.row],
        [anchor.col - 1, anchor.row],
        [anchor.col, anchor.row + 1],
        [anchor.col, anchor.row - 1],
      ];
      for (const [c, r] of candidates) {
        if (this.isWalkableHere(c, r) && !this.isEntityAt(c, r, npcId)) {
          target = { col: c, row: r };
          break;
        }
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
        try {
          npc.sprite.stop();
          npc.sprite.setFrame(FRAME[npc.facing][0]);
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
      const targetX = next.col * TILE_SIZE + TILE_SIZE / 2;
      const targetY = next.row * TILE_SIZE + TILE_SIZE / 2;
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

    const HELPER_TILE = 111; // dwarf/helmeted figure from Kenney Tiny Dungeon
    const tintSeed = (subagentType ?? "default")
      .split("")
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
    const tints: Array<{ l: string; L: string }> = [
      { l: "#ffaa44", L: "#ffd18e" },
      { l: "#4a90e2", L: "#a3c5ff" },
      { l: "#2a9d8f", L: "#8ddccf" },
      { l: "#b5838d", L: "#e5c7ce" },
      { l: "#7b68ee", L: "#b8a5ff" },
    ];
    const tint = tints[Math.abs(tintSeed) % tints.length];

    const helperKey = `gb_helper_${entity.def.id}_${Date.now()}`;
    // Synthesize sheet from tile 111. Reuse the same pipeline as the main
    // NPC textures.
    try {
      this.ensureCharacterTexture(helperKey, HELPER_TILE, tint);
    } catch {
      return;
    }
    this.ensureAnimsFor(helperKey, helperKey);

    // Spawn 1 tile behind the parent's facing direction.
    const [dc, dr] = dirDelta(oppositeDir(entity.facing));
    const spawnPx = entity.sprite.x + dc * TILE_SIZE;
    const spawnPy = entity.sprite.y + dr * TILE_SIZE;

    const sprite = this.add
      .sprite(spawnPx, spawnPy, helperKey, 0)
      // Helper at 1.5x — half of normal sub-agent scale (1.6) ish, keeps
      // it visibly subordinate. Tied to the 32px-tile world.
      .setScale(1.5)
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
  backgroundColor: GB.lightest,
  scene: [WorldScene],
  scale: { mode: Phaser.Scale.NONE },
  input: { keyboard: true },
};

export { NATIVE_W, NATIVE_H };
