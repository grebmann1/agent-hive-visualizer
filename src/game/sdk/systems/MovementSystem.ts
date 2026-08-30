import type {
  Direction,
  Leg,
  ManagedEntity,
  MoveIntent,
  MovementPlan,
  SystemContext,
} from "../types";
import type { NpcRegistry } from "./NpcRegistry";
import type { SeatCell, DeskRect } from "../../tiled-loader";
import type { RoomId } from "../../../events/types";
import { TILE_SIZE } from "../../palette";
import { bfs, type Cell } from "../../pathfind";
import { ROOM_ANCHORS, getRoomRegions, roomIdForCell } from "../../rooms";
import { isRoomReachable } from "../../zones";
import { RouteRuleEngine } from "./RouteRuleEngine";

const STEP_DURATION_MS = 180;
const SHADOW_OFFSET_Y = 7;
const BFS_RETRY_MS = 600;
const MAX_BFS_RETRIES = 5;

const IDLE_FRAME: Record<Direction, number[]> = {
  down: [0, 1, 2, 3],
  up: [6, 7, 8, 9],
  left: [12, 13, 14, 15],
  right: [18, 19, 20, 21],
};

interface ActivePlan {
  plan: MovementPlan;
  legIndex: number;
  path: Cell[];
  seatOffset?: { px: number; py: number; orientation?: Direction };
  retryCount: number;
  dwellUntil?: number;
}

export interface MovementCallbacks {
  /** Optional: invoked when an arrival should trigger a sit-down choreo. */
  onSeatedAtSeat?: (id: string) => void;
}

export class MovementSystem {
  private ctx: SystemContext;
  private registry: NpcRegistry;
  private engine: RouteRuleEngine;
  private callbacks: MovementCallbacks = {};

  private active = new Map<string, ActivePlan>();
  private occupiedSeats = new Map<string, string>(); // "col,row" -> npcId
  private seatByNpc = new Map<string, SeatCell>();

  // Stable per-agent home-desk assignment. Keyed by `npc.state.def.id`,
  // value is one of the `home`-category seats from the .tmj. Survives
  // releaseSeat() so the agent reclaims the same desk after every tool
  // event. Cleared only on `npc:removed` so a fresh session can re-roll.
  private homeSeatByNpc = new Map<string, SeatCell>();

  private seatCells: SeatCell[] = [];
  private homePool: SeatCell[] = []; // category === "home" subset
  private otherPool: SeatCell[] = []; // every other category
  private deskRects: DeskRect[] = [];
  private walkableFn: (col: number, row: number) => boolean = () => true;

  private unsubRemove: (() => void) | undefined;

  constructor(
    ctx: SystemContext,
    registry: NpcRegistry,
    engine: RouteRuleEngine = new RouteRuleEngine(),
  ) {
    this.ctx = ctx;
    this.registry = registry;
    this.engine = engine;

    this.unsubRemove = this.ctx.bus.on("npc:removed", ({ id }) => {
      this.cancelPath(id);
      this.releaseSeat(id);
      // Releasing a despawn frees the home-desk slot so a recycled id
      // (rare) or a brand-new agent can claim it. Live agents keep
      // their home assignment across releaseSeat() calls — only the
      // npc:removed bus event triggers this.
      this.homeSeatByNpc.delete(id);
    });
  }

  /** Store map data and host-side callbacks required for movement. */
  init(
    seatCells: SeatCell[],
    deskRects: DeskRect[],
    walkableFn: (col: number, row: number) => boolean,
    callbacks: MovementCallbacks = {},
  ): void {
    this.seatCells = seatCells;
    // Partition once at init. `claimFreeSeat` walks the home pool first
    // (so an agent's home seat is preferred); `claimFreeSeatInRoom`
    // walks otherPool first for lounge/coffee/meeting cases so
    // opportunistic seats aren't poached by home-seekers.
    this.homePool = seatCells.filter((s) => s.category === "home");
    this.otherPool = seatCells.filter((s) => s.category !== "home");
    this.deskRects = deskRects;
    this.walkableFn = walkableFn;
    this.callbacks = callbacks;
  }

  // ------------------------------------------------------------------
  // Public API — movement
  // ------------------------------------------------------------------

  walkToRoom(id: string, room: RoomId): void {
    const entity = this.registry.get(id);
    if (!entity) return;

    const intent: MoveIntent = {
      npcId: id,
      kind: "room",
      room,
      context: {
        sourceRoom: roomIdForCell(entity.state.col, entity.state.row) ?? undefined,
      },
    };

    const target = this.findRoomTarget(id, room);
    if (!target) return;

    const baseLeg: Leg[] = [{ target, dwellMs: 0, room }];

    const legs = this.engine.process(intent, {
      npcCurrentRoom: roomIdForCell(entity.state.col, entity.state.row) ?? null,
      npcCurrentCell: { col: entity.state.col, row: entity.state.row },
      roomAnchors: ROOM_ANCHORS as Partial<Record<RoomId, Cell>>,
      isReachable: isRoomReachable,
      isWalkable: this.walkableFn,
      getRoomRegions,
    }, baseLeg);

    this.enqueuePlan({ npcId: id, legs, reason: `room:${room}` });
  }

  walkToCell(
    id: string,
    col: number,
    row: number,
    finalOffset?: { px: number; py: number; orientation?: Direction },
  ): void {
    const entity = this.registry.get(id);
    if (!entity) return;

    const leg: Leg = {
      target: { col, row },
      dwellMs: 0,
      finalOffset,
    };

    this.enqueuePlan({ npcId: id, legs: [leg], reason: `cell:(${col},${row})` });
  }

  walkToSeat(id: string, room?: RoomId): void {
    const seat = room
      ? this.claimFreeSeatInRoom(id, room) ?? this.claimFreeSeat(id)
      : this.claimFreeSeat(id);
    if (!seat) return;
    this.walkToCell(id, seat.col, seat.row, {
      px: seat.px,
      py: seat.py,
      orientation: seat.orientation,
    });
  }

  cancelPath(id: string): void {
    const entity = this.registry.get(id);
    if (entity) {
      this.killInflightTween(entity);
      entity.transitTarget = undefined;
    }
    const had = this.active.has(id);
    this.active.delete(id);
    if (had) {
      this.ctx.bus.emit("move:cancelled", { id });
    }
  }

  isWalking(id: string): boolean {
    return this.active.has(id) || (this.registry.get(id)?.visuals.tween != null);
  }

  hasPlan(id: string): boolean {
    return this.active.has(id);
  }

  // ------------------------------------------------------------------
  // Public API — seats
  // ------------------------------------------------------------------

  /** Claim a seat for the given agent. Prefers their stable home desk:
   *  if they don't have one yet, assign deterministically from `homePool`
   *  (FNV-1a hash of `id` modulo pool size, with linear probing to skip
   *  collisions with other agents' homes). On every subsequent call —
   *  including after a `releaseSeat` — return the same home seat unless
   *  it's been claimed by another agent in the interim. Falls through
   *  to any free home seat, then to `otherPool`, only if the home is
   *  unavailable. */
  claimFreeSeat(id: string): SeatCell | null {
    // Lazy home assignment — first time we see this agent, give them one.
    let home = this.homeSeatByNpc.get(id);
    if (!home) {
      home = this.assignHomeSeat(id);
      if (home) this.homeSeatByNpc.set(id, home);
    }

    if (home) {
      const homeKey = `${home.col},${home.row}`;
      const occupant = this.occupiedSeats.get(homeKey);
      if (!occupant || occupant === id) {
        this.occupiedSeats.set(homeKey, id);
        this.seatByNpc.set(id, home);
        return home;
      }
    }

    // Home unavailable (or no home pool at all) — fall through to the
    // first free home seat, then otherPool. Same FIFO behavior as before.
    for (const seat of this.homePool) {
      const key = `${seat.col},${seat.row}`;
      if (this.occupiedSeats.has(key)) continue;
      this.occupiedSeats.set(key, id);
      this.seatByNpc.set(id, seat);
      return seat;
    }
    for (const seat of this.otherPool) {
      const key = `${seat.col},${seat.row}`;
      if (this.occupiedSeats.has(key)) continue;
      this.occupiedSeats.set(key, id);
      this.seatByNpc.set(id, seat);
      return seat;
    }
    return null;
  }

  claimFreeSeatInRoom(id: string, room: RoomId): SeatCell | null {
    const region = getRoomRegions().find((r) => r.id === room);
    if (!region) return null;
    // Try `otherPool` first so cinema-idle / lounge breaks claim
    // CoffeeSeat/LoungeSeat/etc. and never poach a home desk that
    // happens to fall inside the region.
    const ordered = [...this.otherPool, ...this.homePool];
    for (const seat of ordered) {
      if (seat.col < region.colMin || seat.col > region.colMax) continue;
      if (seat.row < region.rowMin || seat.row > region.rowMax) continue;
      const key = `${seat.col},${seat.row}`;
      if (this.occupiedSeats.has(key)) continue;
      this.occupiedSeats.set(key, id);
      this.seatByNpc.set(id, seat);
      return seat;
    }
    return null;
  }

  /** Deterministic home-seat picker. FNV-1a hash of the agent id picks
   *  a starting slot in `homePool`; linear probe skips slots already
   *  assigned to other agents. Returns null when every home seat is
   *  permanently spoken for (caller falls back to otherPool / null). */
  private assignHomeSeat(id: string): SeatCell | undefined {
    if (this.homePool.length === 0) return undefined;
    const taken = new Set<string>();
    for (const seat of this.homeSeatByNpc.values()) {
      taken.add(`${seat.col},${seat.row}`);
    }
    if (taken.size >= this.homePool.length) return undefined;

    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const start = Math.abs(h) % this.homePool.length;
    for (let i = 0; i < this.homePool.length; i++) {
      const slot = this.homePool[(start + i) % this.homePool.length];
      const key = `${slot.col},${slot.row}`;
      if (!taken.has(key)) return slot;
    }
    return undefined;
  }

  releaseSeat(id: string): SeatCell | null {
    const seat = this.seatByNpc.get(id);
    if (!seat) return null;
    this.seatByNpc.delete(id);
    this.occupiedSeats.delete(`${seat.col},${seat.row}`);

    // Restore the standing texture so walk anims play from run sheet
    const entity = this.registry.get(id);
    if (entity?.visuals.sprite?.scene) {
      const sheetKey = this.registry.sheetKeyFor(id);
      if (entity.visuals.sprite.texture.key !== sheetKey) {
        try {
          const frameIdx = IDLE_FRAME[entity.state.facing][0];
          entity.visuals.sprite.setTexture(sheetKey, frameIdx);
        } catch {
          // ignore
        }
      }
    }
    return seat;
  }

  isSeated(id: string): boolean {
    return this.seatByNpc.has(id);
  }

  getSeat(id: string): SeatCell | undefined {
    return this.seatByNpc.get(id);
  }

  resetSeats(): void {
    this.occupiedSeats.clear();
    this.seatByNpc.clear();
    this.homeSeatByNpc.clear();
  }

  get occupiedCount(): number {
    return this.occupiedSeats.size;
  }

  get totalSeats(): number {
    return this.seatCells.length;
  }

  get allSeatCells(): readonly SeatCell[] {
    return this.seatCells;
  }

  get allDeskRects(): readonly DeskRect[] {
    return this.deskRects;
  }

  deskFacingFor(col: number, row: number): Direction {
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

  /** Per-frame tick — drives all active plans forward one step. */
  tick(): void {
    for (const [id, state] of this.active) {
      const entity = this.registry.get(id);
      if (!entity || !entity.visuals.sprite || !entity.visuals.sprite.scene) {
        this.active.delete(id);
        continue;
      }

      // Dwelling between legs
      if (state.dwellUntil) {
        if (this.ctx.scene.time.now < state.dwellUntil) continue;
        state.dwellUntil = undefined;
        state.legIndex++;
        if (state.legIndex >= state.plan.legs.length) {
          this.active.delete(id);
          entity.transitTarget = undefined;
          this.emitArrived(entity);
          continue;
        }
        this.startLeg(id);
        continue;
      }

      // Mid-step — wait for current tween
      if (entity.visuals.tween) continue;

      const next = state.path.shift();
      if (!next) {
        // Current leg drained — apply seat slide if any, then dwell or advance
        const leg = state.plan.legs[state.legIndex];
        if (leg.finalOffset) {
          this.applySeatSlide(entity, leg);
        } else {
          const facing = this.resolveFacing(id, undefined, entity.state.col, entity.state.row);
          entity.state.facing = facing;
          try {
            entity.visuals.sprite.stop();
            const idleKey = this.registry.idleKeyFor(id);
            entity.visuals.sprite.setTexture(idleKey, IDLE_FRAME[facing][0]);
          } catch {
            // sprite torn down
          }
        }

        if (leg.dwellMs > 0) {
          state.dwellUntil = this.ctx.scene.time.now + leg.dwellMs;
        } else {
          state.legIndex++;
          if (state.legIndex >= state.plan.legs.length) {
            this.active.delete(id);
            entity.transitTarget = undefined;
            this.emitArrived(entity);
            continue;
          }
          this.startLeg(id);
        }
        continue;
      }

      // Tile occupied — retry next frame
      if (this.isEntityAt(next.col, next.row, id)) {
        state.path.unshift(next);
        continue;
      }

      this.stepTo(entity, next, state);
    }
  }

  destroy(): void {
    this.unsubRemove?.();
    this.unsubRemove = undefined;

    for (const [id] of this.active) {
      const entity = this.registry.get(id);
      if (entity) this.killInflightTween(entity);
    }

    this.active.clear();
    this.occupiedSeats.clear();
    this.seatByNpc.clear();
    this.homeSeatByNpc.clear();
  }

  // ------------------------------------------------------------------
  // Private — plan management
  // ------------------------------------------------------------------

  private enqueuePlan(plan: MovementPlan): void {
    this.cancelPath(plan.npcId);
    const entity = this.registry.get(plan.npcId);
    if (!entity) return;
    this.killInflightTween(entity);
    if (plan.legs.length === 0) return;

    this.active.set(plan.npcId, {
      plan,
      legIndex: 0,
      path: [],
      retryCount: 0,
    });

    this.startLeg(plan.npcId);
  }

  private startLeg(id: string): void {
    const state = this.active.get(id);
    if (!state) return;
    const entity = this.registry.get(id);
    if (!entity) {
      this.active.delete(id);
      return;
    }

    const leg = state.plan.legs[state.legIndex];
    entity.transitTarget = leg.room;

    const blocked = this.buildBlockedList(id);
    const path = bfs(entity.state.col, entity.state.row, leg.target.col, leg.target.row, { blocked });

    if (path.length === 0) {
      state.retryCount++;
      if (state.retryCount > MAX_BFS_RETRIES) {
        this.active.delete(id);
        entity.transitTarget = undefined;
        return;
      }
      this.ctx.scene.time.delayedCall(BFS_RETRY_MS, () => {
        if (!this.active.has(id)) return;
        this.startLeg(id);
      });
      return;
    }

    if (path.length === 1) {
      state.path = [];
      state.retryCount = 0;
      // Already at leg target — emit started so observers see the plan.
      this.ctx.bus.emit("move:started", {
        id,
        targetCol: leg.target.col,
        targetRow: leg.target.row,
        room: leg.room,
      });
      return;
    }

    state.path = path.slice(1);
    state.retryCount = 0;

    if (leg.finalOffset) {
      state.seatOffset = {
        px: leg.finalOffset.px,
        py: leg.finalOffset.py,
        orientation: leg.finalOffset.orientation,
      };
    } else {
      state.seatOffset = undefined;
    }

    this.ctx.bus.emit("move:started", {
      id,
      targetCol: leg.target.col,
      targetRow: leg.target.row,
      room: leg.room,
    });
  }

  private stepTo(entity: ManagedEntity, next: Cell, state: ActivePlan): void {
    const dc = next.col - entity.state.col;
    const dr = next.row - entity.state.row;
    const dir: Direction =
      dc > 0 ? "right" : dc < 0 ? "left" : dr > 0 ? "down" : "up";
    entity.state.facing = dir;

    const animKey = this.registry.sheetKeyFor(entity.state.id);
    entity.visuals.sprite.play(`${animKey}-walk-${dir}`, true);

    const isLastStep = state.path.length === 0;
    const offset = isLastStep ? state.seatOffset : undefined;
    const targetX = offset ? offset.px : next.col * TILE_SIZE + TILE_SIZE / 2;
    const targetY = offset ? offset.py : next.row * TILE_SIZE + TILE_SIZE / 2;

    const scene = this.ctx.scene;
    const sprite = entity.visuals.sprite;
    const shadow = entity.visuals.shadow;

    entity.visuals.tween = scene.tweens.add({
      targets: sprite,
      x: targetX,
      y: targetY,
      duration: STEP_DURATION_MS,
      ease: "Linear",
      onComplete: () => {
        entity.state.col = next.col;
        entity.state.row = next.row;
        sprite.setDepth(1000 + next.row);
        entity.visuals.tween = undefined;

        this.ctx.bus.emit("move:step", {
          id: entity.state.id,
          col: next.col,
          row: next.row,
          facing: dir,
        });

        if (isLastStep && offset) {
          const facing = this.resolveFacing(entity.state.id, offset.orientation, next.col, next.row);
          entity.state.facing = facing;
          try {
            sprite.stop();
            const idleKey = this.registry.idleKeyFor(entity.state.id);
            sprite.setTexture(idleKey, IDLE_FRAME[facing][0]);
          } catch {
            // sprite torn down
          }
          this.callbacks.onSeatedAtSeat?.(entity.state.id);
        } else if (isLastStep) {
          const facing = this.resolveFacing(entity.state.id, undefined, next.col, next.row);
          entity.state.facing = facing;
          try {
            sprite.stop();
            const idleKey = this.registry.idleKeyFor(entity.state.id);
            sprite.setTexture(idleKey, IDLE_FRAME[facing][0]);
          } catch {
            // sprite torn down
          }
        }
      },
    });

    scene.tweens.add({
      targets: shadow,
      x: targetX,
      y: targetY + SHADOW_OFFSET_Y,
      duration: STEP_DURATION_MS,
      ease: "Linear",
    });

    if (entity.overlays.indicator) {
      scene.tweens.add({
        targets: entity.overlays.indicator,
        x: targetX,
        y: targetY - 14,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
    }

    if (entity.overlays.overheadContainer) {
      scene.tweens.add({
        targets: entity.overlays.overheadContainer,
        x: targetX,
        y: targetY - 20,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
    }
  }

  private applySeatSlide(entity: ManagedEntity, leg: Leg): void {
    if (!leg.finalOffset) return;
    const sprite = entity.visuals.sprite;
    const fromX = sprite.x;
    const fromY = sprite.y;
    const dx = leg.finalOffset.px - fromX;
    const dy = leg.finalOffset.py - fromY;
    const facing = this.resolveFacing(
      entity.state.id,
      leg.finalOffset.orientation,
      entity.state.col,
      entity.state.row,
    );
    entity.state.facing = facing;

    const applySeatedPose = () => {
      try {
        sprite.stop();
        const idleKey = this.registry.idleKeyFor(entity.state.id);
        sprite.setTexture(idleKey, IDLE_FRAME[facing][0]);
      } catch {
        // sprite torn down
      }
      this.callbacks.onSeatedAtSeat?.(entity.state.id);
    };

    if (dx * dx + dy * dy < 0.25) {
      applySeatedPose();
    } else {
      const scene = this.ctx.scene;
      scene.tweens.killTweensOf(sprite);
      scene.tweens.killTweensOf(entity.visuals.shadow);
      scene.tweens.add({
        targets: sprite,
        x: leg.finalOffset.px,
        y: leg.finalOffset.py,
        duration: STEP_DURATION_MS,
        ease: "Linear",
        onComplete: applySeatedPose,
      });
      scene.tweens.add({
        targets: entity.visuals.shadow,
        x: leg.finalOffset.px,
        y: leg.finalOffset.py + SHADOW_OFFSET_Y,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
    }
  }

  private emitArrived(entity: ManagedEntity): void {
    this.ctx.bus.emit("move:arrived", {
      id: entity.state.id,
      col: entity.state.col,
      row: entity.state.row,
    });
  }

  // ------------------------------------------------------------------
  // Private — helpers
  // ------------------------------------------------------------------

  /** Single source of truth for facing direction.
   *  Priority: explicit override > claimed seat orientation > desk-facing heuristic. */
  private resolveFacing(
    id: string,
    override: Direction | undefined,
    col: number,
    row: number,
  ): Direction {
    if (override) return override;
    const seat = this.seatByNpc.get(id);
    if (seat?.orientation) return seat.orientation;
    return this.deskFacingFor(col, row);
  }

  private findRoomTarget(id: string, room: RoomId): { col: number; row: number } | null {
    const anchor = ROOM_ANCHORS[room];
    if (!anchor) return null;

    if (this.walkableFn(anchor.col, anchor.row) && !this.isEntityAt(anchor.col, anchor.row, id)) {
      return { col: anchor.col, row: anchor.row };
    }

    const candidates = [
      [anchor.col + 1, anchor.row],
      [anchor.col - 1, anchor.row],
      [anchor.col, anchor.row + 1],
      [anchor.col, anchor.row - 1],
    ];
    for (const [c, r] of candidates) {
      if (this.walkableFn(c, r) && !this.isEntityAt(c, r, id)) {
        return { col: c, row: r };
      }
    }

    const region = getRoomRegions().find((reg) => reg.id === room);
    if (region) {
      for (let r = region.rowMin; r <= region.rowMax; r++) {
        for (let c = region.colMin; c <= region.colMax; c++) {
          if (this.walkableFn(c, r) && !this.isEntityAt(c, r, id)) {
            return { col: c, row: r };
          }
        }
      }
    }

    return null;
  }

  private killInflightTween(entity: ManagedEntity): void {
    if (entity.visuals.tween) {
      const scene = this.ctx.scene;
      scene.tweens.killTweensOf(entity.visuals.sprite);
      scene.tweens.killTweensOf(entity.visuals.shadow);
      entity.visuals.tween = undefined;

      const sprite = entity.visuals.sprite;
      const cx = Math.round((sprite.x - TILE_SIZE / 2) / TILE_SIZE);
      const cy = Math.round((sprite.y - TILE_SIZE / 2) / TILE_SIZE);
      entity.state.col = cx;
      entity.state.row = cy;
      sprite.setPosition(cx * TILE_SIZE + TILE_SIZE / 2, cy * TILE_SIZE + TILE_SIZE / 2);
      entity.visuals.shadow.setPosition(sprite.x, sprite.y + SHADOW_OFFSET_Y);
    }
  }

  private buildBlockedList(excludeId: string): Array<{ col: number; row: number }> {
    const blocked: Array<{ col: number; row: number }> = [];
    this.registry.forEach((entity, id) => {
      if (id === excludeId) return;
      if (this.active.has(id)) return;
      blocked.push({ col: entity.state.col, row: entity.state.row });
    });
    return blocked;
  }

  private isEntityAt(col: number, row: number, exceptId?: string): boolean {
    let occupied = false;
    this.registry.forEach((entity, id) => {
      if (occupied) return;
      if (id === exceptId) return;
      if (entity.state.col === col && entity.state.row === row) {
        occupied = true;
      }
    });
    return occupied;
  }
}

