import Phaser from "phaser";
import type { SystemContext, ManagedEntity } from "../types";
import type { NpcRegistry } from "./NpcRegistry";
import { TILE_SIZE } from "../../palette";
import { useGameStore } from "../../../stores/useGameStore";

const DRAG_THRESHOLD_PX = 4;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

export class InteractionSystem {
  private ctx: SystemContext;
  private registry: NpcRegistry;

  private dragStart: {
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
  } | null = null;
  private isDragging = false;
  private pointerDownNpcId: string | null = null;

  private pointerdownFn: ((pointer: Phaser.Input.Pointer) => void) | null = null;
  private pointermoveFn: ((pointer: Phaser.Input.Pointer) => void) | null = null;
  private pointerupFn: ((pointer: Phaser.Input.Pointer) => void) | null = null;
  private wheelFn: ((
    pointer: Phaser.Input.Pointer,
    objects: unknown,
    dx: number,
    dy: number,
  ) => void) | null = null;

  constructor(ctx: SystemContext, registry: NpcRegistry) {
    this.ctx = ctx;
    this.registry = registry;
  }

  setup(): void {
    const scene = this.ctx.scene;
    const cam = scene.cameras.main;

    // Make all existing sprites interactive + attach hover listeners.
    this.registry.forEach((entity) => {
      this.wireHover(entity);
    });

    // Listen for future spawns so new sprites also get hover wiring.
    this.ctx.bus.on("npc:spawned", ({ id }) => {
      const entity = this.registry.get(id);
      if (entity) this.wireHover(entity);
    });

    // ---- pointerdown ----
    this.pointerdownFn = (pointer: Phaser.Input.Pointer) => {
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
    };
    scene.input.on("pointerdown", this.pointerdownFn, this);

    // ---- pointermove ----
    this.pointermoveFn = (pointer: Phaser.Input.Pointer) => {
      if (!this.dragStart || !pointer.isDown) return;
      const dx = pointer.x - this.dragStart.x;
      const dy = pointer.y - this.dragStart.y;
      if (!this.isDragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        this.isDragging = true;
        useGameStore.getState().setFollowNpc(null);
        this.ctx.bus.emit("camera:moved", {});
      }
      if (!this.isDragging) return;
      cam.setScroll(
        this.dragStart.scrollX - dx / cam.zoom,
        this.dragStart.scrollY - dy / cam.zoom,
      );
    };
    scene.input.on("pointermove", this.pointermoveFn, this);

    // ---- pointerup / pointerupoutside ----
    this.pointerupFn = (pointer: Phaser.Input.Pointer) => {
      const wasDragging = this.isDragging;
      const downId = this.pointerDownNpcId;
      this.dragStart = null;
      this.isDragging = false;
      this.pointerDownNpcId = null;
      if (wasDragging) return;
      if (pointer.rightButtonReleased()) return;
      const upId = this.npcAtViewPoint(pointer.x, pointer.y);
      if (!downId || downId !== upId) return;
      // Emit `interact:click` and let the host scene decide how to
      // respond (e.g. open a greeting-aware dialog). Hosts that don't
      // listen can still call `openDialog(id)` themselves.
      this.ctx.bus.emit("interact:click", { id: downId });
    };
    scene.input.on("pointerup", this.pointerupFn, this);
    scene.input.on("pointerupoutside", this.pointerupFn, this);

    // ---- wheel ----
    this.wheelFn = (
      pointer: Phaser.Input.Pointer,
      _objects: unknown,
      _dx: number,
      dy: number,
    ) => {
      if (useGameStore.getState().dialog.active) return;
      if (dy === 0) return;
      const oldZoom = cam.zoom;
      const step = Math.min(0.15, Math.abs(dy) * 0.0015);
      const direction = dy > 0 ? -1 : 1;
      const nextZoom = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, oldZoom * Math.exp(direction * step)),
      );
      if (Math.abs(nextZoom - oldZoom) < 0.0005) return;
      const before = cam.getWorldPoint(pointer.x, pointer.y);
      cam.setZoom(nextZoom);
      const after = cam.getWorldPoint(pointer.x, pointer.y);
      cam.scrollX -= after.x - before.x;
      cam.scrollY -= after.y - before.y;
      this.ctx.bus.emit("camera:moved", {});
    };
    scene.input.on("wheel", this.wheelFn, this);
  }

  npcAtViewPoint(viewX: number, viewY: number): string | null {
    const cam = this.ctx.scene.cameras.main;
    const world = cam.getWorldPoint(viewX, viewY);
    const HIT = Math.max(TILE_SIZE / 2, (TILE_SIZE / 2) / cam.zoom);
    let found: string | null = null;
    this.registry.forEach((entity, id) => {
      if (found) return;
      const sprite = entity.visuals.sprite;
      const cx = sprite.x;
      const cy = sprite.y - TILE_SIZE / 2;
      if (Math.abs(cx - world.x) <= HIT && Math.abs(cy - world.y) <= HIT) {
        found = id;
      }
    });
    return found;
  }

  openDialog(id: string): void {
    const entity = this.registry.get(id);
    if (!entity) return;
    const def = entity.state.def;
    useGameStore.getState().openDialog(def);
  }

  summon(id: string): void {
    this.ctx.bus.emit("interact:summon", { id });
  }

  destroy(): void {
    const scene = this.ctx.scene;
    if (this.pointerdownFn) {
      scene.input.off("pointerdown", this.pointerdownFn, this);
    }
    if (this.pointermoveFn) {
      scene.input.off("pointermove", this.pointermoveFn, this);
    }
    if (this.pointerupFn) {
      scene.input.off("pointerup", this.pointerupFn, this);
      scene.input.off("pointerupoutside", this.pointerupFn, this);
    }
    if (this.wheelFn) {
      scene.input.off("wheel", this.wheelFn, this);
    }
  }

  private wireHover(entity: ManagedEntity): void {
    const sprite = entity.visuals.sprite;
    sprite.setInteractive();
    sprite.on("pointerover", () => {
      entity.pillHover = true;
      this.ctx.bus.emit("interact:hover", { id: entity.state.id, hovering: true });
    });
    sprite.on("pointerout", () => {
      entity.pillHover = false;
      this.ctx.bus.emit("interact:hover", { id: entity.state.id, hovering: false });
    });
  }
}
