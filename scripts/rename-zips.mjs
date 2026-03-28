/**
 * Rename WXT zip outputs to remove version numbers.
 * e.g. sc-bridge-sync-0.3.3-chrome.zip → sc-bridge-sync-chrome.zip
 *
 * This keeps asset names stable across releases so download URLs
 * like /releases/latest/download/sc-bridge-sync-chrome.zip always work.
 */
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const outDir = join(import.meta.dirname, "..", ".output");
const pattern = new RegExp(`^sc-bridge-sync-${version.replace(/\./g, "\\.")}-`);

for (const file of readdirSync(outDir)) {
  if (pattern.test(file)) {
    const newName = file.replace(pattern, "sc-bridge-sync-");
    renameSync(join(outDir, file), join(outDir, newName));
    console.log(`  ${file} → ${newName}`);
  }
}
