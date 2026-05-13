import Phaser from "phaser";
import type { RoomId } from "../../events/types";
import type { Cell, Direction, Leg, MovementPlan } from "./types";
import type { SeatManager } from "./seat-manager";
import { TILE_SIZE } from "../palette";
import { bfs } from "../pathfind";
import { logAgent } from "../agentLog";

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

export interface NpcHandle {
  id: string;
  col: number;
  row: number;
  facing: Direction;
  sprite: Phaser.GameObjects.Sprite;
  shadow: { x: number; y: number; setPosition(x: number, y: number): void };
  indicator?: Phaser.GameObjects.Text;
  overheadContainer?: Phaser.GameObjects.Container;
  tween?: Phaser.Tweens.Tween;
  animKey: string;
  idleAnimKey: string;
  transitTarget?: RoomId;
}

export interface ExecutorCallbacks {
  getNpc: (id: string) => NpcHandle | undefined;
  getAllNpcIds: () => string[];
  isWalkable: (col: number, row: number) => boolean;
  onArrived?: (id: string, col: number, row: number, room?: RoomId) => void;
  onStepComplete?: (id: string, col: number, row: number) => void;
  onBlocked?: (id: string, room?: RoomId) => void;
  playIdleAnim?: (npc: NpcHandle) => void;
  startChoreo?: (npc: NpcHandle, kind: string) => void;
}

interface ActivePlan {
  plan: MovementPlan;
  legIndex: number;
  path: Cell[];
  seatOffset?: { px: number; py: number };
  retryCount: number;
  dwellUntil?: number;
}

export class MovementExecutor {
  private scene: Phaser.Scene;
  private cb: ExecutorCallbacks;
  private seatMgr: SeatManager;
  private active = new Map<string, ActivePlan>();

  constructor(scene: Phaser.Scene, cb: ExecutorCallbacks, seatMgr: SeatManager) {
    this.scene = scene;
    this.cb = cb;
    this.seatMgr = seatMgr;
  }

  enqueuePlan(plan: MovementPlan): void {
    this.cancelPlan(plan.npcId);
    const npc = this.cb.getNpc(plan.npcId);
    if (!npc) return;

    this.killInflightTween(npc);

    if (plan.legs.length === 0) return;

    this.active.set(plan.npcId, {
      plan,
      legIndex: 0,
      path: [],
      retryCount: 0,
    });

    this.startLeg(plan.npcId);
  }

  cancelPlan(npcId: string): void {
    const npc = this.cb.getNpc(npcId);
    if (npc) {
      this.killInflightTween(npc);
      npc.transitTarget = undefined;
    }
    this.active.delete(npcId);
  }

  isWalking(npcId: string): boolean {
    return this.active.has(npcId);
  }

  hasPlan(npcId: string): boolean {
    return this.active.has(npcId);
  }

  tick(): void {
    for (const [id, state] of this.active) {
      const npc = this.cb.getNpc(id);
      if (!npc || !npc.sprite || !npc.sprite.scene) {
        this.active.delete(id);
        continue;
      }

      // Dwelling between legs
      if (state.dwellUntil) {
        if (this.scene.time.now < state.dwellUntil) continue;
        state.dwellUntil = undefined;
        state.legIndex++;
        if (state.legIndex >= state.plan.legs.length) {
          this.active.delete(id);
          npc.transitTarget = undefined;
          this.cb.onArrived?.(id, npc.col, npc.row, state.plan.legs[state.legIndex - 1]?.room);
          continue;
        }
        this.startLeg(id);
        continue;
      }

      // Mid-step — wait for tween
      if (npc.tween) continue;

      const next = state.path.shift();
      if (!next) {
        // Current leg path drained — leg arrived
        const leg = state.plan.legs[state.legIndex];

        // Apply seat offset slide on last leg step
        if (leg.finalOffset) {
          this.applySeatSlide(npc, leg);
        } else {
          const facing = this.seatMgr.deskFacingFor(npc.col, npc.row);
          npc.facing = facing;
          try {
            npc.sprite.stop();
            npc.sprite.setTexture(npc.idleAnimKey, IDLE_FRAME[facing][0]);
          } catch { /* sprite torn down */ }
        }

        // Start dwell or advance
        if (leg.dwellMs > 0) {
          state.dwellUntil = this.scene.time.now + leg.dwellMs;
        } else {
          state.legIndex++;
          if (state.legIndex >= state.plan.legs.length) {
            this.active.delete(id);
            npc.transitTarget = undefined;
            this.cb.onArrived?.(id, npc.col, npc.row, leg.room);
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

      this.stepTo(npc, next, state);
    }
  }

  destroy(): void {
    for (const [id] of this.active) {
      const npc = this.cb.getNpc(id);
      if (npc) this.killInflightTween(npc);
    }
    this.active.clear();
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private startLeg(npcId: string): void {
    const state = this.active.get(npcId);
    if (!state) return;
    const npc = this.cb.getNpc(npcId);
    if (!npc) { this.active.delete(npcId); return; }

    const leg = state.plan.legs[state.legIndex];
    npc.transitTarget = leg.room;

    const blocked = this.buildBlockedList(npcId);
    const path = bfs(npc.col, npc.row, leg.target.col, leg.target.row, { blocked });

    if (path.length === 0) {
      // No route — retry up to MAX_BFS_RETRIES
      state.retryCount++;
      if (state.retryCount > MAX_BFS_RETRIES) {
        this.active.delete(npcId);
        npc.transitTarget = undefined;
        this.cb.onBlocked?.(npcId, leg.room);
        return;
      }
      this.scene.time.delayedCall(BFS_RETRY_MS, () => {
        if (!this.active.has(npcId)) return;
        this.startLeg(npcId);
      });
      return;
    }

    if (path.length === 1) {
      // Already at target cell
      state.path = [];
      state.retryCount = 0;
      return;
    }

    state.path = path.slice(1);
    state.retryCount = 0;

    if (leg.finalOffset) {
      state.seatOffset = { px: leg.finalOffset.px, py: leg.finalOffset.py };
    } else {
      state.seatOffset = undefined;
    }

    logAgent({
      ts: Date.now(),
      scene: this.scene.time.now,
      agentId: npcId,
      kind: "summon",
      fromCol: npc.col,
      fromRow: npc.row,
      toCol: leg.target.col,
      toRow: leg.target.row,
      note: `executor: leg ${state.legIndex} → ${leg.room ?? "cell"} (${leg.tag ?? "default"})`,
    });
  }

  private stepTo(npc: NpcHandle, next: Cell, state: ActivePlan): void {
    const dc = next.col - npc.col;
    const dr = next.row - npc.row;
    const dir: Direction =
      dc > 0 ? "right" : dc < 0 ? "left" : dr > 0 ? "down" : "up";
    npc.facing = dir;
    npc.sprite.play(`${npc.animKey}-walk-${dir}`, true);

    const leg = state.plan.legs[state.legIndex];
    const isLastStep = state.path.length === 0;
    const offset = isLastStep ? state.seatOffset : undefined;
    const targetX = offset ? offset.px : next.col * TILE_SIZE + TILE_SIZE / 2;
    const targetY = offset ? offset.py : next.row * TILE_SIZE + TILE_SIZE / 2;

    logAgent({
      ts: Date.now(),
      scene: this.scene.time.now,
      agentId: npc.id,
      kind: "walk-step-start",
      fromCol: npc.col,
      fromRow: npc.row,
      toCol: next.col,
      toRow: next.row,
      fromX: npc.sprite.x,
      fromY: npc.sprite.y,
      toX: targetX,
      toY: targetY,
      note: offset ? `seat-offset px=(${offset.px},${offset.py})` : undefined,
    });

    npc.tween = this.scene.tweens.add({
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

        this.cb.onStepComplete?.(npc.id, next.col, next.row);

        logAgent({
          ts: Date.now(),
          scene: this.scene.time.now,
          agentId: npc.id,
          kind: "walk-step-end",
          fromCol: npc.col,
          fromRow: npc.row,
          toCol: next.col,
          toRow: next.row,
          toX: npc.sprite.x,
          toY: npc.sprite.y,
        });

        if (isLastStep && offset) {
          const seatInfo = this.seatMgr.getSeat(npc.id);
          const facing = seatInfo?.orientation ?? this.seatMgr.deskFacingFor(next.col, next.row);
          npc.facing = facing;
          try {
            npc.sprite.stop();
            npc.sprite.setTexture(npc.idleAnimKey, IDLE_FRAME[facing][0]);
          } catch { /* sprite torn down */ }
          this.cb.startChoreo?.(npc, "sit-down");
        } else if (isLastStep) {
          const seatInfo = this.seatMgr.getSeat(npc.id);
          const facing = seatInfo?.orientation ?? this.seatMgr.deskFacingFor(next.col, next.row);
          npc.facing = facing;
          try {
            npc.sprite.stop();
            npc.sprite.setTexture(npc.idleAnimKey, IDLE_FRAME[facing][0]);
          } catch { /* sprite torn down */ }
        }
      },
    });

    this.scene.tweens.add({
      targets: npc.shadow,
      x: targetX,
      y: targetY + SHADOW_OFFSET_Y,
      duration: STEP_DURATION_MS,
      ease: "Linear",
    });

    if (npc.indicator) {
      this.scene.tweens.add({
        targets: npc.indicator,
        x: targetX,
        y: targetY - 14,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
    }

    if (npc.overheadContainer) {
      this.scene.tweens.add({
        targets: npc.overheadContainer,
        x: targetX,
        y: targetY - 20,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
    }
  }

  private applySeatSlide(npc: NpcHandle, leg: Leg): void {
    if (!leg.finalOffset) return;
    const fromX = npc.sprite.x;
    const fromY = npc.sprite.y;
    const dx = leg.finalOffset.px - fromX;
    const dy = leg.finalOffset.py - fromY;
    const facing = leg.finalOffset.orientation ?? this.seatMgr.deskFacingFor(npc.col, npc.row);
    npc.facing = facing;

    const applySeatedPose = () => {
      try {
        npc.sprite.stop();
        npc.sprite.setTexture(npc.idleAnimKey, IDLE_FRAME[facing][0]);
      } catch { /* sprite torn down */ }
      this.cb.startChoreo?.(npc, "sit-down");
    };

    if (dx * dx + dy * dy < 0.25) {
      applySeatedPose();
    } else {
      this.scene.tweens.killTweensOf(npc.sprite);
      this.scene.tweens.killTweensOf(npc.shadow);
      this.scene.tweens.add({
        targets: npc.sprite,
        x: leg.finalOffset.px,
        y: leg.finalOffset.py,
        duration: STEP_DURATION_MS,
        ease: "Linear",
        onComplete: applySeatedPose,
      });
      this.scene.tweens.add({
        targets: npc.shadow,
        x: leg.finalOffset.px,
        y: leg.finalOffset.py + SHADOW_OFFSET_Y,
        duration: STEP_DURATION_MS,
        ease: "Linear",
      });
    }
  }

  private killInflightTween(npc: NpcHandle): void {
    if (npc.tween) {
      this.scene.tweens.killTweensOf(npc.sprite);
      this.scene.tweens.killTweensOf(npc.shadow);
      npc.tween = undefined;
      const cx = Math.round((npc.sprite.x - TILE_SIZE / 2) / TILE_SIZE);
      const cy = Math.round((npc.sprite.y - TILE_SIZE / 2) / TILE_SIZE);
      npc.col = cx;
      npc.row = cy;
      npc.sprite.setPosition(cx * TILE_SIZE + TILE_SIZE / 2, cy * TILE_SIZE + TILE_SIZE / 2);
      npc.shadow.setPosition(npc.sprite.x, npc.sprite.y + SHADOW_OFFSET_Y);
    }
  }

  private buildBlockedList(excludeId: string): Array<{ col: number; row: number }> {
    const blocked: Array<{ col: number; row: number }> = [];
    for (const otherId of this.cb.getAllNpcIds()) {
      if (otherId === excludeId) continue;
      if (this.active.has(otherId)) continue;
      const other = this.cb.getNpc(otherId);
      if (other) blocked.push({ col: other.col, row: other.row });
    }
    return blocked;
  }

  private isEntityAt(col: number, row: number, exceptId: string): boolean {
    for (const otherId of this.cb.getAllNpcIds()) {
      if (otherId === exceptId) continue;
      const other = this.cb.getNpc(otherId);
      if (other && other.col === col && other.row === row) return true;
    }
    return false;
  }
}
