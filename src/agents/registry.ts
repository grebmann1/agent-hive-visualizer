// Provider registry + concrete API implementation.
//
// Wires any number of `AgentProvider`s up to the game's internal stores.
// The API hands providers a narrow vocabulary — no direct store or Phaser
// access. Swap/add providers by calling `registerProvider(...)` before
// `startAllProviders()` runs.

import type { AgentEvent } from "../events/types";
import {
  makeDynamicNpc,
  useNpcStore,
  type DynamicNpc,
} from "../stores/useNpcStore";
import { useAgentStore } from "../stores/useAgentStore";
import type {
  AgentIdentity,
  AgentProvider,
  AgentProviderAPI,
  AskEvent,
  AskHandle,
} from "./provider";

const providers: AgentProvider[] = [];
const stopFns: Array<() => void> = [];
// Per-agent-id → providerName, so ask() can route to the right backend.
const agentProviderMap = new Map<string, AgentProvider>();

// Refcount so React 19 strict-mode's mount → unmount → mount cycle in dev
// doesn't tear down provider state between mounts. Only the last caller
// actually stops the providers and clears agentProviderMap — otherwise
// events that arrive during the "hidden" second mount get dropped at
// emitEvent because the map was cleared.
let activeCount = 0;

export function registerProvider(p: AgentProvider): void {
  providers.push(p);
}

export function startAllProviders(): void {
  activeCount += 1;
  if (activeCount > 1) return; // already running
  for (const p of providers) {
    const api = createAPI(p);
    const stop = p.start(api);
    stopFns.push(stop);
  }
}

export function stopAllProviders(): void {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount > 0) return; // another caller still needs us
  for (const fn of stopFns) {
    try {
      fn();
    } catch {
      // ignore — shutdown path
    }
  }
  stopFns.length = 0;
  agentProviderMap.clear();
}

// Narrow API handed to providers. The provider instance is captured so we
// can default id prefixes and route `ask()` back to the right provider.
function createAPI(provider: AgentProvider): AgentProviderAPI {
  return {
    upsertAgent(agent: AgentIdentity) {
      if (!agent.id) return;
      agentProviderMap.set(agent.id, provider);
      const store = useNpcStore.getState();
      const existing = store.dynamic[agent.id];
      const parentId =
        (agent.metadata as { parentId?: string } | undefined)?.parentId;
      const terminalId =
        (agent.metadata as { terminalId?: string } | undefined)?.terminalId;
      const external =
        (agent.metadata as { external?: boolean } | undefined)?.external;
      const realPid =
        (agent.metadata as { realPid?: number } | undefined)?.realPid;
      const providerId =
        (agent.metadata as
          | { provider?: import("../stores/useNpcStore").AgentProviderId }
          | undefined)?.provider;
      const subagentType =
        (agent.metadata as { subagentType?: string } | undefined)?.subagentType;
      if (!existing) {
        // Create a new NPC from identity + optional parentId + terminalId.
        const npc: DynamicNpc = makeDynamicNpc({
          id: agent.id,
          name: agent.displayName || agent.id,
          cwd: agent.cwd,
          // cmd is a Claude-specific hint; keep optional.
          cmd: (agent.metadata as { cmd?: string } | undefined)?.cmd,
          parentId,
          terminalId,
          external,
          provider: providerId,
          subagentType,
          pid: realPid,
        });
        store.addDynamic(npc);
        return;
      }
      // Existing NPC — refresh realPid if we only just learned it (common
      // for terminal-linked agents whose first join event didn't resolve
      // the underlying pid in time).
      if (realPid && !existing.pid) {
        store.addDynamic({ ...existing, pid: realPid });
      }
      // Idempotent: refresh the mutable fields if the identity changed.
      // parentId/subagentType can land late (orphan-child claim path
      // in HookProvider): when a parent's Task PreToolUse arrives
      // after the child's first hook, we re-upsert with the parent
      // link so the roster/world reveal the hierarchy retroactively.
      const nextParentId = parentId ?? existing.parentId;
      const nextSubagentType = subagentType ?? existing.subagentType;
      if (
        existing.name !== agent.displayName ||
        existing.cwd !== agent.cwd ||
        existing.parentId !== nextParentId ||
        existing.subagentType !== nextSubagentType
      ) {
        store.addDynamic({
          ...existing,
          name: agent.displayName,
          cwd: agent.cwd,
          parentId: nextParentId,
          subagentType: nextSubagentType,
        });
      }
    },

    removeAgent(id: string) {
      agentProviderMap.delete(id);
      useNpcStore.getState().removeDynamic(id);
    },

    emitEvent(event: AgentEvent) {
      if (!event.agentId) return;
      // Only accept events for agents this provider has registered.
      const owner = agentProviderMap.get(event.agentId);
      if (!owner) return;
      useAgentStore.getState().pushEvent(event);
    },

    ask(agentId: string, prompt: string, onEvent: (e: AskEvent) => void) {
      const owner = agentProviderMap.get(agentId);
      if (
        !owner ||
        typeof (owner as unknown as { askViaProvider?: unknown })
          .askViaProvider !== "function"
      ) {
        return undefined;
      }
      // Providers that want to support chat expose `askViaProvider` as an
      // internal method (not part of the formal AgentProvider interface to
      // keep the required surface small).
      const method = (owner as unknown as {
        askViaProvider: (
          agentId: string,
          prompt: string,
          onEvent: (e: AskEvent) => void,
        ) => AskHandle | undefined;
      }).askViaProvider;
      return method(agentId, prompt, onEvent);
    },
  };
}

// Helpful for tests and dev debug panels.
export function listProviders(): ReadonlyArray<AgentProvider> {
  return providers;
}
