# Agent Force HQ — docs

A 2D pixel-art desktop app where every Claude agent on your laptop
becomes a visible character in a top-down office. Hook events from
each running `claude` session drive the world in real time.

Pick where to start:

- **[Install & connect Claude](install.md)** — get the app (DMG,
  build, or dev) and wire it into your `~/.claude/settings.json`
  (one click or manual). Includes what gets written, how to verify,
  and how to uninstall.
- **[Build the installer](build-installer.md)** — produce a signed
  DMG locally; how to notarize for distribution.
- **[Debug teleporting agents](debug-teleport.md)** — capture the
  in-app motion log (Shift+E) and use it to find rogue
  position writes when an NPC appears to jump across the canvas.
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
