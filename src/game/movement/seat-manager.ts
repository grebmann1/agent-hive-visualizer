import type { RoomId } from "../../events/types";
import type { DeskRect, SeatCell } from "../tiled-loader";
import { getRoomRegions } from "../rooms";
import type { Direction } from "./types";

export class SeatManager {
  private occupiedSeats = new Map<string, string>();
  private seatByNpc = new Map<string, SeatCell>();
  private seatCells: SeatCell[] = [];
  private deskRects: DeskRect[] = [];

  init(seatCells: SeatCell[], deskRects: DeskRect[]): void {
    this.seatCells = seatCells;
    this.deskRects = deskRects;
  }

  reset(): void {
    this.occupiedSeats.clear();
    this.seatByNpc.clear();
  }

  claimFreeSeat(npcId: string): SeatCell | null {
    for (const seat of this.seatCells) {
      const key = `${seat.col},${seat.row}`;
      if (this.occupiedSeats.has(key)) continue;
      this.occupiedSeats.set(key, npcId);
      this.seatByNpc.set(npcId, seat);
      return seat;
    }
    return null;
  }

  claimFreeSeatInRoom(npcId: string, room: RoomId): SeatCell | null {
    const region = getRoomRegions().find((r) => r.id === room);
    if (!region) return null;
    for (const seat of this.seatCells) {
      if (seat.col < region.colMin || seat.col > region.colMax) continue;
      if (seat.row < region.rowMin || seat.row > region.rowMax) continue;
      const key = `${seat.col},${seat.row}`;
      if (this.occupiedSeats.has(key)) continue;
      this.occupiedSeats.set(key, npcId);
      this.seatByNpc.set(npcId, seat);
      return seat;
    }
    return null;
  }

  releaseSeat(npcId: string): SeatCell | null {
    const seat = this.seatByNpc.get(npcId);
    if (!seat) return null;
    this.seatByNpc.delete(npcId);
    this.occupiedSeats.delete(`${seat.col},${seat.row}`);
    return seat;
  }

  isSeated(npcId: string): boolean {
    return this.seatByNpc.has(npcId);
  }

  getSeat(npcId: string): SeatCell | undefined {
    return this.seatByNpc.get(npcId);
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
}
