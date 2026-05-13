import type { RoomId } from "../../events/types";

export type Direction = "up" | "down" | "left" | "right";

export type { Cell } from "../pathfind";

export interface Leg {
  target: { col: number; row: number };
  finalOffset?: { px: number; py: number; orientation?: Direction };
  dwellMs: number;
  room?: RoomId;
  tag?: string;
}

export interface MovementPlan {
  npcId: string;
  legs: Leg[];
  reason: string;
}

export type MoveIntent =
  | {
      npcId: string;
      kind: "room";
      room: RoomId;
      context?: MoveIntentContext;
    }
  | {
      npcId: string;
      kind: "cell";
      col: number;
      row: number;
      finalOffset?: { px: number; py: number; orientation?: Direction };
      context?: MoveIntentContext;
    }
  | {
      npcId: string;
      kind: "seat";
      room?: RoomId;
      context?: MoveIntentContext;
    };

export interface MoveIntentContext {
  sourceRoom?: RoomId;
  behaviorId?: string;
  isBreak?: boolean;
}
