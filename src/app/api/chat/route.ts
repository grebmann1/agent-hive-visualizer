import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { NPCS, npcById } from "../../../game/npcs";

export const runtime = "nodejs";

interface ChatBody {
  npcId: string;
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  // Dynamic NPCs (spawned from live claude processes) send their persona inline
  // because the server doesn't know about them.
  personaName?: string;
  systemPrompt?: string;
}

// Small safety net — keep responses short so the dialog box stays readable.
const MAX_TOKENS = 200;
const MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "ANTHROPIC_API_KEY not configured",
        fallback: mockReply("missing_key"),
      },
      { status: 200 }, // return 200 with fallback so UI can still show something
    );
  }

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const staticNpc = npcById(body.npcId);
  const systemPrompt = staticNpc?.systemPrompt ?? body.systemPrompt;

  if (!systemPrompt) {
    return NextResponse.json(
      { error: `Unknown npc: ${body.npcId} (no system prompt supplied)` },
      { status: 404 },
    );
  }

  const client = new Anthropic({ apiKey });

  try {
    const messages: Anthropic.MessageParam[] = [];
    for (const turn of body.history ?? []) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: "user", content: body.userMessage });

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    });

    const text =
      resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim() || "…";

    const inferredStates = inferStates(body.userMessage, body.npcId);

    return NextResponse.json({ reply: text, states: inferredStates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: msg,
        fallback: mockReply("api_error", body.userMessage, body.npcId, body.personaName),
      },
      { status: 200 },
    );
  }
}

// Cheap heuristic — map the user's question to visualizer state changes
// so the NPC is seen moving through rooms while Claude is "thinking".
function inferStates(userMessage: string, npcId: string): string[] {
  const m = userMessage.toLowerCase();
  const states: string[] = [];
  if (/build|write|code|fix|make/.test(m)) states.push("planning", "reading_file", "coding");
  if (/test|verify|check/.test(m)) states.push("running_tests");
  if (/find|search|look|research|where/.test(m)) states.push("searching");
  if (/deploy|ship|publish/.test(m)) states.push("deploying");
  if (states.length === 0) {
    if (npcId === "codey") states.push("thinking", "coding");
    else if (npcId === "searchy") states.push("searching");
    else if (npcId === "testy") states.push("running_tests");
    else states.push("calling_tool");
  }
  return states;
}

function mockReply(reason: string, q?: string, npcId?: string, personaName?: string): string {
  const npc = npcId ? npcById(npcId) : undefined;
  const name = npc?.name ?? personaName ?? "the agent";
  if (reason === "missing_key") {
    return `(${name} hums a tune.) No API key is set, so I'm just in demo mode. Set ANTHROPIC_API_KEY to chat for real!`;
  }
  if (q && /hi|hello|hey/i.test(q)) return `${name}: Hi there!`;
  return `${name}: (the radio crackles) I can't think clearly right now — try again in a moment.`;
}
