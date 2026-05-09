import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Electron-builder packaged output — never lint generated files.
    "release/**",
    "tiled/**",
    // Electron-side Node modules: CommonJS by design (require, module.exports).
    // Next's typescript-aware config flags require() as forbidden, which is
    // appropriate for the renderer but not for these scripts.
    "electron/**",
  ]),
  // The `react-hooks/set-state-in-effect` rule was bumped to error in
  // recent eslint-config-next versions. Several modal/dialog effects
  // here legitimately load localStorage state or seed local UI state
  // on open — that's exactly what useEffect is for. Downgrade so the
  // false positives don't gate CI; we still see them as warnings.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
