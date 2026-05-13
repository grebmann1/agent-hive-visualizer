import type { RoomId } from "../../events/types";
import type { Cell } from "../pathfind";
import type { Leg, MoveIntent } from "./types";

export interface RouteRuleContext {
  npcCurrentRoom: RoomId | null;
  npcCurrentCell: Cell;
  roomAnchors: Partial<Record<RoomId, Cell>>;
  isReachable: (room: RoomId) => boolean;
  isWalkable: (col: number, row: number) => boolean;
  getRoomRegions: () => Array<{ id: RoomId; colMin: number; colMax: number; rowMin: number; rowMax: number }>;
}

export interface RouteRule {
  id: string;
  priority: number;
  matches: (intent: MoveIntent, ctx: RouteRuleContext) => boolean;
  apply: (legs: Leg[], intent: MoveIntent, ctx: RouteRuleContext) => Leg[];
}

export const ROUTE_RULES: RouteRule[] = [
  {
    id: "unreachable-room-fallback",
    priority: 100,
    matches: (intent, ctx) =>
      intent.kind === "room" && !ctx.isReachable(intent.room),
    apply: (_legs, intent, ctx) => {
      if (intent.kind !== "room") return _legs;
      const FALLBACK: Partial<Record<RoomId, RoomId>> = {
        desk: "meeting_room",
        coding_room: "meeting_room",
        testing_lab: "meeting_room",
        tool_workshop: "meeting_room",
      };
      const alt = FALLBACK[intent.room] ?? "lounge";
      const anchor = ctx.roomAnchors[alt];
      if (!anchor) return _legs;
      return [{ target: anchor, dwellMs: 0, room: alt }];
    },
  },

  {
    id: "coffee-stop-lounge-to-work",
    priority: 10,
    matches: (intent, ctx) =>
      intent.kind === "room" &&
      ctx.npcCurrentRoom === "lounge" &&
      intent.room !== "lounge",
    apply: (legs, _intent, ctx) => {
      const loungeAnchor = ctx.roomAnchors["lounge"];
      if (!loungeAnchor) return legs;
      return [
        {
          target: { col: loungeAnchor.col + 2, row: loungeAnchor.row },
          dwellMs: 2000,
          room: "lounge",
          tag: "coffee-stop",
        },
        ...legs,
      ];
    },
  },
];
