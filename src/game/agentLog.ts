// Agent motion log — circular buffer of every event that moves an
// NPC sprite or changes its tile. Used to debug "the agent
// teleports" reports: by replaying the log we can spot Δpx > TILE
// between consecutive entries for the same agent (= teleport).
//
// The log is intentionally lightweight: no DOM, no network, no
// per-frame allocation. Pre-sized buffer; oldest entries get
// overwritten once we hit BUFFER_CAP.
//
// Producers: WorldScene's movement code (walkNpcToCell tween,
// tickNpcPaths, addNpcEntity spawn pop, releaseSeat texture swap,
// tickSpriteSeparation push, summonNpcToCell, helper spawn,
// removeNpcEntity tween-out, hover scale, choreo).
//
// Consumer: a download button in the in-app HUD or the dev console
// (`window.agentLog.download()`).

const BUFFER_CAP = 5000;

export type AgentLogKind =
  | "spawn"
  | "remove"
  | "walk-step-start" // the per-tile walk tween starts
  | "walk-step-end" // the tween onComplete fires (col/row commits)
  | "walk-step-skip" // path step blocked / retried
  | "seat-snap" // last-step pixel-center seat offset applied
  | "separation" // tickSpriteSeparation nudged the sprite
  | "summon" // user clicked summon and we walked them to a cell
  | "helper-spawn" // floating helper sprite
  | "helper-despawn"
  | "hover-scale"
  | "choreo-start"
  | "choreo-stop"
  | "texture-swap" // sprite.setTexture (sit pose, run pose)
  | "warn"; // anomaly: full path bypass / mid-tween reset / etc.

export interface AgentLogEntry {
  ts: number; // Date.now()
  scene: number; // scene.time.now (ms since scene boot)
  agentId: string;
  kind: AgentLogKind;
  // Cell-space (tile coordinates) before/after, when meaningful.
  fromCol?: number;
  fromRow?: number;
  toCol?: number;
  toRow?: number;
  // Pixel-space before/after (sprite.x/sprite.y at the moment of
  // the event). Helps the teleport diagnosis: the script flags any
  // entry pair for the same agent where Δpx > TILE_SIZE without an
  // intermediate walk-step-* entry between them.
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  // Optional human-readable note (room name, choreo kind, error).
  note?: string;
}

const buf: AgentLogEntry[] = [];

// Off by default. Toggled from the in-app Debug panel (which mirrors
// the value to localStorage so it survives reloads). When disabled,
// `logAgent` is a no-op — no allocation, no buffer growth.
const STORAGE_KEY = "agentquest:agentlog:enabled";
let enabled = false;

if (typeof window !== "undefined") {
  try {
    enabled = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage may be unavailable (private mode, etc.) — leave off.
  }
}

export function isEnabled(): boolean {
  return enabled;
}

export function setEnabled(next: boolean): void {
  enabled = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // ignore
    }
  }
  if (!next) {
    // Free the buffer when the user disables logging.
    buf.length = 0;
  }
}

export function logAgent(entry: AgentLogEntry): void {
  if (!enabled) return;
  buf.push(entry);
  // Cheap ring-buffer trim. We tolerate a one-frame window where
  // length > CAP because the splice cost of trimming on every push
  // outweighs any benefit at the read side (export is rare).
  if (buf.length > BUFFER_CAP + 100) {
    buf.splice(0, buf.length - BUFFER_CAP);
  }
}

export function snapshot(): AgentLogEntry[] {
  return buf.slice();
}

export function clear(): void {
  buf.length = 0;
}

export function size(): number {
  return buf.length;
}

/**
 * Trigger a browser download of the buffer as JSON. Called from a
 * keyboard shortcut + a HUD button. Filename includes a timestamp
 * so multiple captures don't overwrite each other.
 */
export function download(): void {
  const data = JSON.stringify(snapshot(), null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `agent-log-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

// Expose to the dev console for ad-hoc inspection. The browser-only
// guard avoids ReferenceError in any SSR codepath.
if (typeof window !== "undefined") {
  (
    window as unknown as { agentLog?: Record<string, unknown> }
  ).agentLog = {
    snapshot,
    download,
    clear,
    size,
    isEnabled,
    setEnabled,
  };
}
