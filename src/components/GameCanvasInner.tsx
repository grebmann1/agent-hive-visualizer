"use client";

import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { worldSceneConfig, WorldScene } from "../game/WorldScene";
import { TILE_SIZE } from "../game/palette";
import { useContextMenuStore } from "../stores/useContextMenuStore";

// Target CSS zoom for pixel tiles. In v2.0 the in-game zoom is driven by
// Phaser's camera (wheel to zoom), so CSS zoom only needs to be "enough
// to make pixel art look crisp" — NOT the semantic zoom level. Keep this
// low so the free-pan camera has plenty of room to roam.
const TARGET_ZOOM = 1.5;

export default function GameCanvasInner() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  // Resize Phaser to exactly fill the panel. No letterbox: we pick a
  // viewport whose pixel dimensions equal `panelPx / TARGET_ZOOM` (rounded
  // to whole tiles), then ask Phaser to resize the renderer + camera to
  // that native size. CSS scales the resulting canvas by TARGET_ZOOM so
  // pixels stay crisp.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    let currentW = 0;
    let currentH = 0;

    const applySize = (cssW: number, cssH: number) => {
      // Native (pre-zoom) dimensions — do NOT snap to whole tiles; the camera
      // can render partial tiles at the edges, and snapping leaves a visible
      // dark gap at the bottom where the panel is taller than the snapped size.
      const nativeW = Math.max(TILE_SIZE, Math.floor(cssW / TARGET_ZOOM));
      const nativeH = Math.max(TILE_SIZE, Math.floor(cssH / TARGET_ZOOM));
      // CSS size — round UP to guarantee the canvas covers the whole panel
      // (a 1px overhang is harmless; a 1px gap is ugly).
      const finalCssW = Math.ceil(cssW);
      const finalCssH = Math.ceil(cssH);

      if (currentW === nativeW && currentH === nativeH) return;
      currentW = nativeW;
      currentH = nativeH;

      const g = gameRef.current;
      if (!g) return;
      g.scale.resize(nativeW, nativeH);
      // Size the CSS canvas directly (Scale.NONE doesn't auto-apply CSS).
      const canvas = g.canvas as HTMLCanvasElement;
      if (canvas) {
        canvas.style.width = `${finalCssW}px`;
        canvas.style.height = `${finalCssH}px`;
      }
    };

    const recompute = () => {
      const ps = window.getComputedStyle(parent);
      const pxPad =
        parseFloat(ps.paddingLeft) + parseFloat(ps.paddingRight);
      const pyPad =
        parseFloat(ps.paddingTop) + parseFloat(ps.paddingBottom);
      const w = Math.max(1, parent.clientWidth - pxPad);
      const h = Math.max(1, parent.clientHeight - pyPad);
      applySize(w, h);
    };

    // Defer first measurement until after Phaser boots — use requestAnimationFrame.
    const raf = requestAnimationFrame(recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(parent);
    window.addEventListener("resize", recompute);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    const game = new Phaser.Game({
      ...worldSceneConfig,
      parent: containerRef.current,
    });
    gameRef.current = game;
    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  // Right-click on the canvas → hit-test an NPC and open the context menu.
  // The canvas is CSS-scaled by TARGET_ZOOM, so we convert client coords
  // to native camera-view pixels before asking the scene. Phaser calls
  // `disableContextMenu()` in the scene's create() so the browser menu
  // never shows; we only need to catch the event and do hit-testing.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const g = gameRef.current;
      if (!g) return;
      const canvas = g.canvas as HTMLCanvasElement | undefined;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const viewX = (e.clientX - rect.left) * scaleX;
      const viewY = (e.clientY - rect.top) * scaleY;
      const scene = g.scene.getScene("WorldScene") as WorldScene | undefined;
      if (!scene) return;
      const npcId = scene.npcAtViewPoint(viewX, viewY);
      if (!npcId) return;
      // Portal the menu into the game panel itself (the parent of the
      // canvas container). That element has `position: relative` so the
      // menu positions absolutely inside it — physically cannot escape
      // the game window no matter the layout.
      const anchor = el.parentElement ?? el;
      useContextMenuStore.getState().openAt(e.clientX, e.clientY, npcId, anchor);
    };
    // Capture phase on the container covers both the Phaser canvas and
    // anything layered on top of it.
    el.addEventListener("contextmenu", onContextMenu, { capture: true });
    return () =>
      el.removeEventListener("contextmenu", onContextMenu, { capture: true });
  }, []);

  // Stop the browser from scrolling the page when the user wheels over the
  // game canvas. Phaser still receives the wheel event via its own listener
  // and handles zoom — this only kills the default page-scroll behavior.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    // The container fills the whole panel. Phaser injects its canvas as a
    // child; we sized the canvas via JS (width/height CSS props) so it
    // matches the container exactly. Background color of the container is
    // only visible in the ~1px rounding gap at most.
    <div
      ref={containerRef}
      className="absolute inset-0 flex items-center justify-center bg-paper overflow-hidden pixelated"
      style={{ cursor: "grab" }}
    >
      <style jsx>{`
        div :global(canvas) {
          image-rendering: pixelated;
          display: block;
        }
        div:active {
          cursor: grabbing;
        }
      `}</style>
    </div>
  );
}
