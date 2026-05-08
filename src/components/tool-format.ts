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

/** Short narrative summary of a known shell command — turns `git commit
 *  -m '...'` into "committing changes" so the bubble feels less like a
 *  raw log line. Returns null for commands we don't have a handle on,
 *  so the caller can fall back to the verbatim snippet. */
function describeBashCommand(cmd: string): string | null {
  const c = cmd.trim().toLowerCase();
  if (!c) return null;
  if (/^git\s+commit\b/.test(c)) return "committing changes";
  if (/^git\s+push\b/.test(c)) return "pushing the branch";
  if (/^git\s+pull\b/.test(c)) return "pulling latest";
  if (/^git\s+(merge|rebase)\b/.test(c)) return "stitching branches together";
  if (/^git\s+(status|diff|log|show|blame)\b/.test(c)) return "checking the diff";
  if (/^git\s+(checkout|switch|branch)\b/.test(c)) return "switching branches";
  if (/^git\s+stash\b/.test(c)) return "stashing changes";
  if (/^(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b/.test(c)) return "installing dependencies";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests?|jest|vitest)\b/.test(c)) return "running tests";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|prettier|eslint)\b/.test(c)) return "linting";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|tsc)\b/.test(c)) return "running the build";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/.test(c)) return "starting the dev server";
  if (/^(npx|bunx|pnpm\s+dlx)\b/.test(c)) return "running a one-off tool";
  if (/^(make|mvn|gradle|cargo|go|python|node|deno|ruby|php)\b/.test(c)) return "running a build tool";
  if (/^(curl|wget|http|httpie)\b/.test(c)) return "calling an endpoint";
  if (/^(rg|grep|ag|ack|fd|find)\b/.test(c)) return "searching the codebase";
  if (/^(ls|cat|head|tail|less|more|file|stat|wc|du|df)\b/.test(c)) return "inspecting files";
  if (/^(cd|pwd|mkdir|touch|cp|mv|rm)\b/.test(c)) return "tidying the workspace";
  if (/^(docker|kubectl|helm|terraform|ansible|aws|gcloud|az)\b/.test(c)) return "talking to infra";
  if (/^(ssh|scp|rsync)\b/.test(c)) return "talking to a remote host";
  if (/^(ps|top|htop|kill|pkill|lsof)\b/.test(c)) return "inspecting processes";
  return null;
}

/** Drop the trailing extension from a path. ".../Foo.tsx" → "Foo". Used
 *  to keep file-context lines short without hiding the meaningful name. */
function basenameNoExt(path: string): string {
  const base = path.split(/[/\\]/).filter(Boolean).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

export function buildToolMessage(
  toolName: string | undefined,
  input: unknown,
): string {
  switch (toolName) {
    case "Read": {
      const fp = getStr(input, "file_path");
      return fp ? `reading ${basenameNoExt(fp)}` : "reading a file";
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const fp = getStr(input, "file_path") ?? getStr(input, "notebook_path");
      return fp ? `editing ${basenameNoExt(fp)}` : "editing a file";
    }
    case "Write": {
      const fp = getStr(input, "file_path");
      return fp ? `writing ${basenameNoExt(fp)}` : "writing a new file";
    }
    case "Bash": {
      const cmd = (getStr(input, "command") ?? "").trim();
      const narrative = describeBashCommand(cmd);
      if (narrative) return narrative;
      const snippet = cmd.slice(0, 40);
      return snippet ? `running \`${snippet}\`` : "running a command";
    }
    case "Grep": {
      const pat = getStr(input, "pattern");
      return pat ? `grepping for "${pat.slice(0, 30)}"` : "searching the code";
    }
    case "Glob": {
      const pat = getStr(input, "pattern");
      return pat ? `looking for ${pat.slice(0, 30)}` : "scanning files";
    }
    case "WebFetch": {
      const url = getStr(input, "url");
      try {
        const host = url ? new URL(url).host : "";
        return host ? `fetching from ${host}` : "fetching a page";
      } catch {
        return "fetching a page";
      }
    }
    case "WebSearch": {
      const q = getStr(input, "query");
      return q ? `searching the web for "${q.slice(0, 30)}"` : "searching the web";
    }
    case "Task": {
      const desc =
        getStr(input, "description") ?? getStr(input, "subagent_type");
      return desc
        ? `delegating: ${desc.slice(0, 40)}`
        : "delegating to a helper";
    }
    case "TodoWrite":
      return "updating the plan";
    default:
      return toolName ? `using ${toolName}` : "working";
  }
}
