/*
 * electron-builder afterSign hook — submits the .app to Apple for notarization.
 *
 * Runs only when ALL of these are present:
 *   APPLE_ID                  — your Apple developer email
 *   APPLE_APP_SPECIFIC_PASSWORD — app-specific password (NOT your Apple ID password)
 *   APPLE_TEAM_ID             — your Developer Team ID (10 chars)
 *
 * Without them, the hook no-ops with a warning. This means `npm run dist` still
 * produces a .dmg locally for testing; you just won't clear Gatekeeper without
 * first-launch right-click -> Open.
 *
 * Notarization takes 2–15 min. electron-builder blocks until complete.
 */

const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "[notarize] Skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set.",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] Submitting ${appPath} to Apple...`);

  await notarize({
    tool: "notarytool",
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("[notarize] Done.");
};
