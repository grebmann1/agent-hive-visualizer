// Shared helpers for turning a claude `tool_use` block's name + input into
// a short human-readable line. Moved out of DialogBox.tsx so DialogBox,
// LiveThread, ActivityModal, and AgentRoster can all render consistent
// text for the same underlying tool call.

export function getStr(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object") {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

export function shortPath(p: string | undefined): string {
  if (!p) return "";
  const clean = p.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length <= 2) return clean;
  return parts.slice(-2).join("/");
}

export function buildToolMessage(
  toolName: string | undefined,
  input: unknown,
): string {
  switch (toolName) {
    case "Read": {
      const fp = getStr(input, "file_path");
      return fp ? `Reading ${shortPath(fp)}` : "Reading a file";
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const fp = getStr(input, "file_path") ?? getStr(input, "notebook_path");
      return fp ? `Editing ${shortPath(fp)}` : "Editing a file";
    }
    case "Write": {
      const fp = getStr(input, "file_path");
      return fp ? `Writing ${shortPath(fp)}` : "Writing a file";
    }
    case "Bash": {
      const cmd = getStr(input, "command") ?? "";
      const snippet = cmd.slice(0, 60);
      return snippet ? `Running: ${snippet}` : "Running a command";
    }
    case "Grep": {
      const pat = getStr(input, "pattern");
      return pat ? `Grep "${pat.slice(0, 40)}"` : "Searching";
    }
    case "Glob": {
      const pat = getStr(input, "pattern");
      return pat ? `Glob ${pat.slice(0, 40)}` : "Searching files";
    }
    case "WebFetch": {
      const url = getStr(input, "url");
      return url ? `Fetching ${url.slice(0, 50)}` : "Fetching web";
    }
    case "WebSearch": {
      const q = getStr(input, "query");
      return q ? `Searching "${q.slice(0, 40)}"` : "Searching the web";
    }
    case "Task": {
      const desc =
        getStr(input, "description") ?? getStr(input, "subagent_type");
      return desc ? `Thinking: ${desc.slice(0, 40)}` : "Launching a sub-task";
    }
    case "TodoWrite":
      return "Updating the plan";
    default:
      return toolName ? `Using ${toolName}` : "Working";
  }
}
