import Phaser from "phaser";
import { createEventBus, type EventBus } from "./event-bus";
import { NpcRegistry } from "./systems/NpcRegistry";
import { MovementSystem } from "./systems/MovementSystem";
import { ChoreoSystem } from "./systems/ChoreoSystem";
import { InteractionSystem } from "./systems/InteractionSystem";
import type { SeatCell, DeskRect } from "../tiled-loader";
import type { MovementCallbacks } from "./systems/MovementSystem";

export class GameSdk {
  readonly bus: EventBus;
  readonly registry: NpcRegistry;
  readonly movement: MovementSystem;
  readonly choreo: ChoreoSystem;
  readonly interaction: InteractionSystem;

  constructor(scene: Phaser.Scene) {
    this.bus = createEventBus();

    const ctx = { scene, bus: this.bus };

    this.registry = new NpcRegistry(ctx);
    this.movement = new MovementSystem(ctx, this.registry);
    this.choreo = new ChoreoSystem(ctx, this.registry);
    this.interaction = new InteractionSystem(ctx, this.registry);
  }

  /** Call after map data is loaded. Passes geometry to systems that need it. */
  init(opts: {
    seatCells: SeatCell[];
    deskRects: DeskRect[];
    walkableFn: (col: number, row: number) => boolean;
    movementCallbacks?: MovementCallbacks;
  }): void {
    this.movement.init(
      opts.seatCells,
      opts.deskRects,
      opts.walkableFn,
      opts.movementCallbacks ?? {},
    );
    this.interaction.setup();
  }

  /** Per-frame update — dispatches to all systems that need ticking. */
  tick(_time: number, _delta: number): void {
    this.movement.tick();
    this.choreo.tickDecay();
  }

  /** Full teardown — destroys all systems and the bus. */
  destroy(): void {
    this.interaction.destroy();
    this.choreo.destroy();
    this.movement.destroy();
    this.registry.destroy();
    this.bus.destroy();
  }
}
