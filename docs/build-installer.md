# Building the macOS installer

Agent Force HQ ships as a standard macOS DMG (drag-and-drop into
`/Applications`) plus a zip mirror for distribution channels that
prefer it.

---

## One-shot build

```bash
npm run dist
```

That runs `next build` → syncs the Tiled map → invokes
`electron-builder --mac`. Output lands in `release/`:

```
release/
├── Agent Force HQ-<version>.dmg            # universal (arm64 + x64)
├── Agent Force HQ-<version>-arm64-mac.zip  # Apple Silicon zip
├── Agent Force HQ-<version>-mac.zip        # universal zip
├── *.blockmap                              # delta-update metadata
└── mac-arm64/                              # raw .app bundle (debug)
```

The DMG is what you ship to end users. The zips are convenience
mirrors (Homebrew Cask, S3 buckets, …) and the blockmaps are for
electron-updater delta downloads if you wire that in later.

---

## What the installer looks like

When the user double-clicks the DMG they see a 540 × 380 window with
two icons:

- **Agent Force HQ.app** on the left
- A symlink to `/Applications` on the right

Drag-to-install → done. The window layout is configured in
`package.json`'s `build.dmg.contents` block.

---

## Code-signing & notarization

`build/notarize.js` handles Apple notarization when the right env
vars are set:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist
```

Without these, the DMG is signed (electron-builder picks up the
"Developer ID Application" cert from your local keychain) but
**not notarized**. macOS Gatekeeper will then show a "this app
can't be opened" warning the first time the user launches; they
can right-click → Open → Open to bypass it once.

For wide distribution always set the notarization env vars.

---

## Faster iteration

For iteration on the packaged app without rebuilding the DMG:

```bash
npm run pack
```

This produces `release/mac-arm64/Agent Force HQ.app/` directly —
launch it with:

```bash
open "release/mac-arm64/Agent Force HQ.app"
```

Same code path as the dist build, just no DMG wrapper.

---

## Verifying the DMG

After building you can sanity-check the disk image:

```bash
hdiutil verify "release/Agent Force HQ-0.1.0.dmg"
hdiutil attach "release/Agent Force HQ-0.1.0.dmg" -readonly -nobrowse
ls "/Volumes/Agent Force HQ 0.1.0/"
hdiutil detach "/Volumes/Agent Force HQ 0.1.0/"
```

You should see `Agent Force HQ.app` and a `Applications` symlink.

---

## Common errors

**`hdiutil: couldn't unmount "diskN" - Resource busy`** — a previous
dmgbuild run left the volume mounted. Run
`hdiutil detach /Volumes/<name>` and rebuild. Restarting Spotlight
sometimes helps too (it can hold the mount).

**`signing` failures** — usually a missing or expired Developer ID
cert. Open Keychain Access, search for "Developer ID Application",
confirm a non-expired entry exists.

**Notarization timeout** — Apple's notary service can take 10+
minutes. The build's `afterSign` hook polls until ticket; if you
need to skip it locally, unset `APPLE_ID` and rebuild.

---

## Distributing

The simplest path:

1. Build with notarization env vars set.
2. Upload `release/Agent Force HQ-<version>.dmg` to a GitHub
   release.
3. Link to it from the README.

The zip mirrors are handy if you want a Homebrew Cask:

```ruby
cask "agent-force-hq" do
  version "0.1.0"
  sha256 "..."
  url "https://github.com/grebmann1/agent-hive-visualizer/releases/download/v#{version}/Agent.Force.HQ-#{version}-arm64-mac.zip"
  name "Agent Force HQ"
  app "Agent Force HQ.app"
end
```
