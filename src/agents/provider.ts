// AgentProvider — the plug-in surface for anything that wants to show
// agents in the world.
//
// The game's rendering layer (WorldScene, DialogBox, Agent Roster, etc.)
// only knows about two kinds of data:
//   1. AgentIdentity  — "there is an agent called X running at path Y"
//   2. AgentEvent     — "agent X just did Z" (from src/events/types.ts)
//
// A provider's only job is to observe some external source (Claude Code
// transcripts, an OpenAI session, a webhook, a local script) and push
// identity + event updates through the generic `AgentProviderAPI`.
//
// To plug a new provider in:
//
//   export class MyProvider implements AgentProvider {
//     readonly name = "my-thing";
//     start(api: AgentProviderAPI): () => void {
//       // Subscribe to your source. Whenever something happens:
//       api.upsertAgent({ id: "my-thing:42", displayName: "Reggie",
//                         providerName: "my-thing" });
//       api.emitEvent({
//         type: "agent.state.changed",
//         agentId: "my-thing:42",
//         state: "coding",
//         message: "Editing index.ts",
//         timestamp: new Date().toISOString(),
//         metadata: { toolName: "Edit", input: { file_path: "index.ts" } },
//       });
//       // ...and on shutdown:
//       return () => { /* stop listening */ };
//     }
//   }
//
// Then register it once at app boot:
//
//   registerProvider(new MyProvider());
//
// The provider never touches React state or Phaser directly. The API gives
// it a narrow vocabulary; the rest of the app guarantees consistent visual
// behavior regardless of which provider the event came from.

import type { AgentEvent } from "../events/types";

export interface AgentIdentity {
  /** Globally unique id. Convention: `${providerName}:${localId}` — but any
   * stable string works. The UI uses this as a React key and store key. */
  id: string;
  /** Short user-facing name ("Claude-242", "gpt-4-worker-7"). */
  displayName: string;
  /** Which AgentProvider owns this agent. */
  providerName: string;
  /** Current working directory, if meaningful. Used by the dialog box to
   * open a `claude -p` subprocess in the right spot (or equivalent per
   * provider). Optional — providers without a cwd concept omit it. */
  cwd?: string;
  /** Freeform per-provider data. The game ignores this; roster/dialog can
   * reveal it behind a "details" button. */
  metadata?: Record<string, unknown>;
}

export interface AgentProviderAPI {
  /** Register or update an identity. Idempotent — safe to call repeatedly
   * with the same id. First call spawns the NPC in the world; later calls
   * refresh metadata (e.g. name change). */
  upsertAgent(agent: AgentIdentity): void;

  /** Remove an agent by id. NPC fades out in the world. */
  removeAgent(id: string): void;

  /** Queue an event for the agent with `event.agentId`. If the agent was
   * not previously registered, the event is a no-op (providers should call
   * `upsertAgent` first). */
  emitEvent(event: AgentEvent): void;

  /** Ask a question of an agent. Returns a handle that can be cancelled;
   * the provider decides what "asking" means (subprocess, HTTP, etc.).
   * Optional — providers that don't support interactive chat return
   * undefined and the UI uses its fallback `/api/chat` path. */
  ask?(
    agentId: string,
    prompt: string,
    onEvent: (event: AskEvent) => void,
  ): AskHandle | undefined;
}

export type AskEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; toolName: string; input?: unknown }
  | { type: "done"; fullText?: string }
  | { type: "error"; message: string };

export interface AskHandle {
  cancel: () => void;
  dispose: () => void;
}

export interface AgentProvider {
  /** Machine-readable name. Used in `AgentIdentity.providerName` and in
   * logs. Keep it short and kebab-cased. */
  readonly name: string;

  /** Attach the provider to the app. Returns a stop function that cleans
   * up all listeners/subscriptions. */
  start(api: AgentProviderAPI): () => void;
}
