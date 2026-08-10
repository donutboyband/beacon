// Ad-hoc sign the packed app bundle. Without ANY valid signature, macOS
// Gatekeeper shows downloaders "Beacon is damaged" with no way through; with
// an ad-hoc one they get "unidentified developer" and can choose Open Anyway.
//
// electron-builder runs afterPack BEFORE its own signing step, so when a real
// Developer ID identity is configured this ad-hoc signature is simply replaced
// by the proper one — the hook is safe to keep either way.
const { execSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: "inherit" });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${appName}.app (no Developer ID found)`);
};
