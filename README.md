# Agent Force HQ

A 2D pixel-art desktop app where every Claude agent on your laptop
becomes a visible character in a top-down office. Watch your agents
walk between rooms as they think, code, search, and run tools — in
real time, driven by actual hook events from each running `claude`
session.

![Agent Force HQ — agents working in a top-down pixel office](docs/images/agent-force-hq-screenshot.png)

Built with Next.js, Phaser, Zustand, and Electron. Packaged as a
native macOS app.

## Why

When you have multiple Claude sessions running across terminals,
IDEs, and project directories, it's hard to keep a mental model of
who's doing what. Agent Force HQ turns that invisible activity into a
**living office floor** — a cozy, glanceable visualization where:

- Each running `claude` session is an NPC with a stable look and name.
- The room they're in tells you what they're doing right now.
- The pill above their head shows the current tool with an emoji.
- Idle agents drift to a desk and sit until the next event arrives.

It's the difference between watching a status bar and watching your
agents *actually work*.

## Quick start

```bash
npm install
npm run dev
```

That launches the Next.js dev server and opens the Electron window.
Open a real terminal, `cd` into any project, and run `claude` — your
agent should appear inside the **Reception** entrance and walk to a
free desk within a few seconds.

## How it works at a glance

```
Claude CLI hook event
  → ~/.agentquest/bin/post-hook.sh   (POST 127.0.0.1:47329)
  → electron/hook-server.js
  → IPC "claude:hook"
  → src/agents/hook-provider.ts      maps tool → AgentState → RoomId
  → src/game/WorldScene.ts           BFS path + tweened sprite walk
```

- First hook event for a session **materializes** an NPC inside the
  Tiled-authored `Start` rect.
- Each subsequent tool call walks the agent to the matching room
  (Read → Library, Edit → DevOps, Bash → War Room, …).
- `Stop` events leave the agent free to drift to a desk seat.
- `SessionEnd` (or 10 min of total silence) walks the agent out.

The full mapping is documented in
[`docs/hooks-and-rooms.md`](docs/hooks-and-rooms.md).

## Roadmap

- **More hook events** — `UserPromptSubmit`, `Notification`,
  `PermissionRequest`, `PreCompact` / `PostCompact`. New rooms
  (Reception, Security Checkpoint, Archive) absorb each one.
- **More providers** — Cursor agents and a master-hive Claude
  orchestrating sub-teams. The `AgentProvider` seam is already in
  place (`src/agents/provider.ts`); each new source just emits the
  same `AgentEvent` shape.
- **Per-room desk assignment** — today the seat pool is global;
  future Read agents will sit at Library desks specifically.

## Documentation

- [`docs/hooks-and-rooms.md`](docs/hooks-and-rooms.md) — pipeline,
  full hook→room mapping, Tiled object naming reference, planned
  rooms, multi-provider story.

The Markdown files in `docs/` are designed to be served as a
GitHub-Pages site straight from the `docs/` folder — no build
step. To enable:

1. Push the repo to GitHub.
2. **Settings → Pages → Source: Deploy from branch**, choose
   `main` (or your default) + `/docs` folder.
3. Save. GitHub serves `docs/index.md` (if present) as the
   landing page; today the entry point is
   `docs/hooks-and-rooms.md`.

For a richer site (sidebar, search, versioning) we can later swap
in [Docusaurus](https://docusaurus.io/) — the markdown is
front-matter-free so it'll port over without rewriting.

## License

MIT for this project's source. Pixel art:
- Kenney.nl Tiny Dungeon — CC0
- Limezu Modern Office Revamped (characters) — CC0
