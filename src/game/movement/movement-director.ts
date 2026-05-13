import type { RoomId } from "../../events/types";
import { ROOM_ANCHORS, getRoomRegions, roomIdForCell } from "../rooms";
import { isRoomReachable } from "../zones";
import type { Direction, Leg, MoveIntent, MovementPlan } from "./types";
import { RouteRuleEngine } from "./route-rule-engine";
import { MovementExecutor, type ExecutorCallbacks, type NpcHandle } from "./movement-executor";
import { SeatManager } from "./seat-manager";
import type Phaser from "phaser";

export interface DirectorConfig {
  scene: Phaser.Scene;
  callbacks: ExecutorCallbacks;
  seatManager: SeatManager;
  ruleEngine?: RouteRuleEngine;
}

export class MovementDirector {
  private executor: MovementExecutor;
  private ruleEngine: RouteRuleEngine;
  private seatMgr: SeatManager;
  private cb: ExecutorCallbacks;

  constructor(config: DirectorConfig) {
    this.cb = config.callbacks;
    this.seatMgr = config.seatManager;
    this.ruleEngine = config.ruleEngine ?? new RouteRuleEngine();
    this.executor = new MovementExecutor(config.scene, config.callbacks, config.seatManager);
  }

  moveToRoom(npcId: string, room: RoomId): void {
    const npc = this.cb.getNpc(npcId);
    if (!npc) return;

    const intent: MoveIntent = {
      npcId,
      kind: "room",
      room,
      context: {
        sourceRoom: roomIdForCell(npc.col, npc.row) ?? undefined,
      },
    };

    const target = this.findRoomTarget(npc, room);
    if (!target) return;

    const baseLeg: Leg[] = [{ target, dwellMs: 0, room }];

    const ctx = {
      npcCurrentRoom: roomIdForCell(npc.col, npc.row) ?? null,
      npcCurrentCell: { col: npc.col, row: npc.row },
      roomAnchors: ROOM_ANCHORS as Partial<Record<RoomId, { col: number; row: number }>>,
      isReachable: isRoomReachable,
      isWalkable: this.cb.isWalkable,
      getRoomRegions,
    };

    const legs = this.ruleEngine.process(intent, ctx, baseLeg);

    const plan: MovementPlan = {
      npcId,
      legs,
      reason: `room:${room}`,
    };

    this.executor.enqueuePlan(plan);
  }

  moveToCell(
    npcId: string,
    col: number,
    row: number,
    finalOffset?: { px: number; py: number; orientation?: Direction },
  ): void {
    const npc = this.cb.getNpc(npcId);
    if (!npc) return;

    const leg: Leg = {
      target: { col, row },
      dwellMs: 0,
      finalOffset,
    };

    const plan: MovementPlan = {
      npcId,
      legs: [leg],
      reason: `cell:(${col},${row})`,
    };

    this.executor.enqueuePlan(plan);
  }

  moveToSeat(npcId: string, room?: RoomId): void {
    const seat = room
      ? this.seatMgr.claimFreeSeatInRoom(npcId, room) ?? this.seatMgr.claimFreeSeat(npcId)
      : this.seatMgr.claimFreeSeat(npcId);

    if (!seat) return;

    this.moveToCell(npcId, seat.col, seat.row, {
      px: seat.px,
      py: seat.py,
      orientation: seat.orientation,
    });
  }

  cancelMovement(npcId: string): void {
    this.executor.cancelPlan(npcId);
  }

  isWalking(npcId: string): boolean {
    return this.executor.isWalking(npcId);
  }

  hasPlan(npcId: string): boolean {
    return this.executor.hasPlan(npcId);
  }

  tick(): void {
    this.executor.tick();
  }

  destroy(): void {
    this.executor.destroy();
  }

  get engine(): RouteRuleEngine {
    return this.ruleEngine;
  }

  get seats(): SeatManager {
    return this.seatMgr;
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private findRoomTarget(
    npc: NpcHandle,
    room: RoomId,
  ): { col: number; row: number } | null {
    const anchor = ROOM_ANCHORS[room];
    if (!anchor) return null;

    if (
      this.cb.isWalkable(anchor.col, anchor.row) &&
      !this.isEntityAt(anchor.col, anchor.row, npc.id)
    ) {
      return { col: anchor.col, row: anchor.row };
    }

    const candidates = [
      [anchor.col + 1, anchor.row],
      [anchor.col - 1, anchor.row],
      [anchor.col, anchor.row + 1],
      [anchor.col, anchor.row - 1],
    ];
    for (const [c, r] of candidates) {
      if (this.cb.isWalkable(c, r) && !this.isEntityAt(c, r, npc.id)) {
        return { col: c, row: r };
      }
    }

    const region = getRoomRegions().find((reg) => reg.id === room);
    if (region) {
      for (let r = region.rowMin; r <= region.rowMax; r++) {
        for (let c = region.colMin; c <= region.colMax; c++) {
          if (this.cb.isWalkable(c, r) && !this.isEntityAt(c, r, npc.id)) {
            return { col: c, row: r };
          }
        }
      }
    }

    return null;
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
