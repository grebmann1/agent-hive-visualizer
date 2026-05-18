import Phaser from "phaser";
import type { ChoreoKind, ChoreoHandle } from "../choreo";
import type { NpcDef } from "../npcs";
import type { RoomId } from "../../events/types";
import type { EventBus } from "./event-bus";

export type Direction = "down" | "up" | "left" | "right";

export interface EntityState {
  id: string;
  def: NpcDef;
  col: number;
  row: number;
  facing: Direction;
  restingScale: number;
  isSubAgent: boolean;
  parentId?: string;
}

export interface EntityVisuals {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Rectangle;
  tween?: Phaser.Tweens.Tween;
}

export interface EntityOverlays {
  indicator?: Phaser.GameObjects.Text;
  overheadContainer?: Phaser.GameObjects.Container;
  overheadBg?: Phaser.GameObjects.Graphics;
  overheadCodeText?: Phaser.GameObjects.Text;
  overheadEmojiText?: Phaser.GameObjects.Text;
  helperBadge?: Phaser.GameObjects.Text;
  transitBadge?: Phaser.GameObjects.Text;
}

export interface ManagedEntity {
  state: EntityState;
  visuals: EntityVisuals;
  overlays: EntityOverlays;
  choreo?: { kind: ChoreoKind; handle: ChoreoHandle; startedAt: number };
  overheadBaselineEmoji?: string;
  overheadErrorUntil?: number;
  overheadPromptUntil?: number;
  pillHover?: boolean;
  transitTarget?: RoomId;
  transitText?: string;
}

export interface SystemContext {
  scene: Phaser.Scene;
  bus: EventBus;
}

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

export interface MoveIntentContext {
  sourceRoom?: RoomId;
  behaviorId?: string;
  isBreak?: boolean;
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
