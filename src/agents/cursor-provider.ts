// CursorProvider — placeholder surface for future Cursor-agent integration.
//
// Cursor doesn't yet expose a stable IPC for "AI-mode is active in this
// editor". When it does, this provider will:
//   - Watch the Cursor IPC / file-watcher / CLI feed.
//   - Translate observable activity (file edits, AI panel state, tool
//     calls inside agent mode) into AgentEvent messages.
//   - upsertAgent with metadata.provider = "cursor" so the renderer
//     picks a distinct sprite pool / pill color.
//
// For now the provider is a no-op — registered behind the
// AGENT_HIVE_ENABLE_CURSOR feature flag in registry.ts so it doesn't
// run by default. The skeleton is here so the registration plumbing
// + multi-provider flow can be smoke-tested ahead of the real wiring.

import type {
  AgentProvider,
  AgentProviderAPI,
} from "./provider";

export class CursorProvider implements AgentProvider {
  readonly name = "cursor";

  start(_api: AgentProviderAPI): () => void {
    if (typeof window !== "undefined") {
      console.info(
        "[cursor-provider] active (skeleton) — no IPC wired yet, no agents will appear from this source",
      );
    }
    // No-op; return cleanup fn. Real implementation will subscribe to
    // Cursor's activity surface here and call _api.upsertAgent /
    // _api.emitEvent with `metadata.provider: "cursor"`.
    return () => {
      // nothing to clean up yet
    };
  }
}
