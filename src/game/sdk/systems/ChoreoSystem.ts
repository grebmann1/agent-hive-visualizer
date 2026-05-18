import { startChoreo } from "../../choreo";
import type { ChoreoKind } from "../../choreo";
import type { ManagedEntity, SystemContext } from "../types";
import type { NpcRegistry } from "./NpcRegistry";

/**
 * Manages per-tool choreography animations for NPC entities.
 *
 * Subscribes to "npc:removed" on the event bus to automatically clean up
 * active choreos when an NPC is despawned.
 */
export class ChoreoSystem {
  private ctx: SystemContext;
  private registry: NpcRegistry;
  private unsubRemoved: () => void;

  constructor(ctx: SystemContext, registry: NpcRegistry) {
    this.ctx = ctx;
    this.registry = registry;

    this.unsubRemoved = this.ctx.bus.on("npc:removed", ({ id }) => {
      this.stopInternal(id, false);
    });
  }

  /**
   * Play a choreo on the given NPC. Stops any existing choreo first.
   * If the same kind is already playing, refreshes the start time.
   */
  play(id: string, kind: ChoreoKind): void {
    const entity = this.registry.get(id);
    if (!entity) return;

    // If the same choreo is already running, just refresh the timestamp.
    if (entity.choreo && entity.choreo.kind === kind) {
      entity.choreo.startedAt = this.ctx.scene.time.now;
      return;
    }

    // Stop the existing choreo if any.
    if (entity.choreo) {
      this.stopExistingChoreo(entity);
    }

    const handle = startChoreo(this.ctx.scene, { sprite: entity.visuals.sprite }, kind, entity.state.facing);
    entity.choreo = { kind, handle, startedAt: this.ctx.scene.time.now };

    this.ctx.bus.emit("choreo:started", { id, kind });
  }

  /**
   * Stop the active choreo for the given NPC.
   */
  stop(id: string): void {
    this.stopInternal(id, true);
  }

  /**
   * Return the active choreo kind for the given NPC, or null if none.
   */
  currentKind(id: string): ChoreoKind | null {
    const entity = this.registry.get(id);
    if (!entity || !entity.choreo) return null;
    return entity.choreo.kind;
  }

  /**
   * Per-frame tick: for each entity with an active choreo, if it has been
   * running longer than 12 seconds, stop it automatically.
   */
  tickDecay(): void {
    const now = this.ctx.scene.time.now;
    this.registry.forEach((entity) => {
      if (!entity.choreo) return;
      if (entity.choreo.kind === "idle-bob") return;
      if (now - entity.choreo.startedAt < 12_000) return;
      this.stopInternal(entity.state.id, true);
    });
  }

  /**
   * Tear down the system: stop all active choreos and unsubscribe from bus.
   */
  destroy(): void {
    this.registry.forEach((entity) => {
      if (entity.choreo) {
        this.stopExistingChoreo(entity);
      }
    });
    this.unsubRemoved();
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private stopInternal(id: string, emit: boolean): void {
    const entity = this.registry.get(id);
    if (!entity || !entity.choreo) return;

    const kind = entity.choreo.kind;
    this.stopExistingChoreo(entity);

    if (emit) {
      this.ctx.bus.emit("choreo:stopped", { id, kind });
    }
  }

  private stopExistingChoreo(entity: ManagedEntity): void {
    if (!entity.choreo) return;
    try {
      entity.choreo.handle.stop();
    } catch {
      // ignore — handle may already be stopped
    }
    try {
      entity.visuals.sprite.setScale(entity.state.restingScale);
    } catch {
      // ignore — sprite may have been destroyed
    }
    entity.choreo = undefined;
  }
}
