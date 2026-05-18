export interface SdkEventMap {
  "npc:spawned": { id: string; col: number; row: number; isSubAgent: boolean };
  "npc:removed": { id: string };

  "move:started": { id: string; targetCol: number; targetRow: number; room?: string };
  "move:step": { id: string; col: number; row: number; facing: string };
  "move:arrived": { id: string; col: number; row: number };
  "move:cancelled": { id: string };

  "choreo:started": { id: string; kind: string };
  "choreo:stopped": { id: string; kind: string };

  "interact:click": { id: string };
  "interact:hover": { id: string; hovering: boolean };
  "interact:summon": { id: string };
  /** Fired the first time the user pans or zooms after scene start.
   *  Hosts use this to stop auto-fitting the viewport on panel resize. */
  "camera:moved": Record<string, never>;

  "wl:transition": { id: string; from: string; to: string; trigger: string };

  "store:activity": { id: string; room: string; choreo: string; toolName?: string };
  "store:npc-added": { id: string };
  "store:npc-removed": { id: string };
  "store:settings-changed": { key: string; value: unknown };
}

type Handler<T> = (payload: T) => void;

export interface EventBus {
  emit<K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void;
  on<K extends keyof SdkEventMap>(event: K, handler: Handler<SdkEventMap[K]>): () => void;
  once<K extends keyof SdkEventMap>(event: K, handler: Handler<SdkEventMap[K]>): void;
  destroy(): void;
}

export function createEventBus(): EventBus {
  const listeners = new Map<keyof SdkEventMap, Handler<never>[]>();

  function getList<K extends keyof SdkEventMap>(event: K): Handler<never>[] {
    let list = listeners.get(event);
    if (!list) {
      list = [];
      listeners.set(event, list);
    }
    return list;
  }

  function emit<K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void {
    const list = listeners.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      list[i](payload as never);
    }
  }

  function on<K extends keyof SdkEventMap>(event: K, handler: Handler<SdkEventMap[K]>): () => void {
    const list = getList(event);
    list.push(handler as Handler<never>);
    return () => {
      const idx = list.indexOf(handler as Handler<never>);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  function once<K extends keyof SdkEventMap>(event: K, handler: Handler<SdkEventMap[K]>): void {
    const unsub = on(event, (payload) => {
      unsub();
      handler(payload);
    });
  }

  function destroy(): void {
    listeners.clear();
  }

  return { emit, on, once, destroy };
}
