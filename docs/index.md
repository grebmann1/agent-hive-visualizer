# Agent Force HQ — docs

A 2D pixel-art desktop app where every Claude agent on your laptop
becomes a visible character in a top-down office. Hook events from
each running `claude` session drive the world in real time.

Pick where to start:

- **[Install & connect Claude](install.md)** — wire Agent Force HQ
  into your `~/.claude/settings.json` (one click or manual). Includes
  what gets written to disk, how to verify, and how to uninstall.
- **[How it works](architecture.md)** — the full pipeline from a
  Claude hook to a sprite walking on the map. Render layers, visual
  vocabulary (pill emojis, badges, tethers, time-of-day tint), the
  sub-agent linker, and a "where to look when something doesn't
  move" cheat sheet.
- **[Hooks → Rooms reference](hooks-and-rooms.md)** — the full
  hook → state → room mapping table, Tiled object naming reference,
  planned rooms, multi-provider seam.

Project README: [`../README.md`](../README.md).

Repo: <https://github.com/grebmann1/agent-hive-visualizer>.
