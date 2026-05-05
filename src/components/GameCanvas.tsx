"use client";

import dynamic from "next/dynamic";

const GameCanvas = dynamic(() => import("./GameCanvasInner"), {
  ssr: false,
  loading: () => (
    <div className="flex justify-center">
      <div
        className="bg-gb-lightest border-2 border-gb-darkest flex items-center justify-center text-gb-darkest text-[8px]"
        style={{ width: 768, height: 512 }}
      >
        LOADING WORLD...
      </div>
    </div>
  ),
});

export default GameCanvas;
