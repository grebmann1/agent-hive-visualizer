import type { NpcDef } from "../../npcs";
import type { ManagedEntity, SystemContext } from "../types";
import { TILE_SIZE } from "../../palette";

const MODERN_CHARS = ["Adam", "Alex", "Amelia", "Bob"] as const;
type ModernChar = (typeof MODERN_CHARS)[number];

const AGENT_TINTS = [
  0xffffff,
  0xffd1a4,
  0xa9d6ff,
  0xffb1d2,
  0xc9e7a4,
  0xd4b4ff,
  0xffe17a,
  0xa3e3d6,
] as const;

const FRAME_DOWN_0 = 0;
const SHADOW_OFFSET_Y = 7;
const SHADOW_W = 10;
const SHADOW_H = 3;
const SHADOW_COLOR = 0x0f380f;
const SHADOW_ALPHA = 0.35;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function hashMul31(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31 + s.charCodeAt(i)) | 0);
  }
  return Math.abs(h);
}

export class NpcRegistry {
  private entities = new Map<string, ManagedEntity>();
  private ctx: SystemContext;

  constructor(ctx: SystemContext) {
    this.ctx = ctx;
  }

  add(
    def: NpcDef,
    spawnCol: number,
    spawnRow: number,
    opts?: { isSubAgent?: boolean; parentId?: string },
  ): ManagedEntity {
    if (this.entities.has(def.id)) {
      return this.entities.get(def.id)!;
    }

    const isSubAgent = opts?.isSubAgent ?? false;
    const restingScale = isSubAgent ? 0.8 : 1.0;

    const px = spawnCol * TILE_SIZE + TILE_SIZE / 2;
    const py = spawnRow * TILE_SIZE + TILE_SIZE / 2;

    const scene = this.ctx.scene;

    const shadow = scene.add
      .rectangle(px, py + SHADOW_OFFSET_Y, SHADOW_W, SHADOW_H, SHADOW_COLOR, SHADOW_ALPHA)
      .setDepth(999);

    const sheetKey = this.sheetKeyFor(def.id);
    const sprite = scene.add
      .sprite(px, py, sheetKey, FRAME_DOWN_0)
      .setDepth(1000 + spawnRow);

    const tint = this.tintFor(def.id);
    if (tint !== 0xffffff) sprite.setTint(tint);

    const entity: ManagedEntity = {
      state: {
        id: def.id,
        def,
        col: spawnCol,
        row: spawnRow,
        facing: "down",
        restingScale,
        isSubAgent,
        parentId: opts?.parentId,
      },
      visuals: {
        sprite,
        shadow,
      },
      overlays: {},
    };

    this.entities.set(def.id, entity);

    this.ctx.bus.emit("npc:spawned", {
      id: def.id,
      col: spawnCol,
      row: spawnRow,
      isSubAgent,
    });

    return entity;
  }

  /** Register a ManagedEntity built outside the SDK (sprite/shadow already
   *  exist on the scene). Used by WorldScene during the migration so the
   *  SDK has a view onto the same Phaser objects WorldScene already owns.
   *  No-op if the id is already registered.
   *
   *  Unlike `add()`, `attach()` does NOT destroy the visuals on `remove()` —
   *  the host owns the lifetime. Use `detach()` to drop the registry entry. */
  attach(id: string, entity: ManagedEntity): ManagedEntity {
    if (this.entities.has(id)) return this.entities.get(id)!;
    this.entities.set(id, entity);
    this.ctx.bus.emit("npc:spawned", {
      id,
      col: entity.state.col,
      row: entity.state.row,
      isSubAgent: entity.state.isSubAgent,
    });
    return entity;
  }

  /** Drop a registry entry without destroying its visuals. Pair with
   *  `attach()` when the host owns sprite/shadow lifetimes. */
  detach(id: string): void {
    if (!this.entities.has(id)) return;
    this.entities.delete(id);
    this.ctx.bus.emit("npc:removed", { id });
  }

  remove(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    entity.visuals.sprite.destroy();
    entity.visuals.shadow.destroy();
    entity.overlays.indicator?.destroy();
    entity.overlays.overheadContainer?.destroy();
    entity.overlays.helperBadge?.destroy();
    entity.overlays.transitBadge?.destroy();

    this.entities.delete(id);

    this.ctx.bus.emit("npc:removed", { id });
  }

  get(id: string): ManagedEntity | undefined {
    return this.entities.get(id);
  }

  has(id: string): boolean {
    return this.entities.has(id);
  }

  forEach(fn: (entity: ManagedEntity, id: string) => void): void {
    this.entities.forEach(fn);
  }

  count(): number {
    return this.entities.size;
  }

  characterFor(id: string): string {
    const seed = `claude:${id}`;
    return MODERN_CHARS[hashString(seed) % MODERN_CHARS.length];
  }

  sheetKeyFor(id: string): string {
    const char = this.characterFor(id) as ModernChar;
    return `modern_${char.toLowerCase()}`;
  }

  idleKeyFor(id: string): string {
    const char = this.characterFor(id) as ModernChar;
    return `modern_${char.toLowerCase()}_idle`;
  }

  sitKeyFor(id: string): string {
    const char = this.characterFor(id) as ModernChar;
    return `modern_${char.toLowerCase()}_sit`;
  }

  tintFor(id: string): number {
    return AGENT_TINTS[hashMul31(id) % AGENT_TINTS.length];
  }

  destroy(): void {
    this.entities.forEach((entity) => {
      entity.visuals.sprite.destroy();
      entity.visuals.shadow.destroy();
      entity.overlays.indicator?.destroy();
      entity.overlays.overheadContainer?.destroy();
      entity.overlays.helperBadge?.destroy();
      entity.overlays.transitBadge?.destroy();
    });
    this.entities.clear();
  }
}
