import type { AgentEvent } from "./types";

type Emit = (event: AgentEvent) => void;

const AGENT_ID = "codey";

function event(partial: Omit<AgentEvent, "agentId" | "timestamp">): AgentEvent {
  return {
    ...partial,
    agentId: AGENT_ID,
    timestamp: new Date().toISOString(),
  };
}

const script: Array<{ delay: number; build: () => AgentEvent }> = [
  {
    delay: 0,
    build: () =>
      event({
        type: "agent.state.changed",
        state: "planning",
        message: "I need a plan!",
      }),
  },
  {
    delay: 1200,
    build: () =>
      event({
        type: "agent.state.changed",
        state: "reading_file",
        message: "Reading existing code",
      }),
  },
  {
    delay: 1400,
    build: () =>
      event({
        type: "agent.file.edited",
        message: "Editing LoginForm.tsx",
        metadata: { file: "LoginForm.tsx", language: "TypeScript" },
      }),
  },
  {
    delay: 1400,
    build: () =>
      event({
        type: "agent.state.changed",
        state: "running_tests",
        message: "Running tests",
      }),
  },
  {
    delay: 1400,
    build: () =>
      event({
        type: "agent.tool.called",
        message: "Using vitest",
        metadata: { toolName: "vitest" },
      }),
  },
  {
    delay: 1200,
    build: () =>
      event({
        type: "agent.completed",
        message: "Tests passed! Login page is ready.",
      }),
  },
  {
    delay: 1200,
    build: () =>
      event({
        type: "agent.waiting_for_user",
        message: "Done! Waiting for you.",
      }),
  },
];

export function runLoginPageDemo(emit: Emit): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cumulative = 0;
  for (const step of script) {
    cumulative += step.delay;
    const t = setTimeout(() => emit(step.build()), cumulative);
    timers.push(t);
  }
  return () => timers.forEach(clearTimeout);
}
