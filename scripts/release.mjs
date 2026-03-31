#!/usr/bin/env node
/**
 * Release script — automates the full release lifecycle:
 *
 * 1. Bumps version in package.json (patch/minor/major)
 * 2. Builds + zips all 4 browsers + sources
 * 3. Renames zips to stable names (no version numbers)
 * 4. Cleans up old versioned zips and stale build folders
 * 5. Commits the version bump
 * 6. Creates a git tag
 * 7. Pushes to GitHub
 * 8. Creates a GitHub release with all 5 zip assets
 *
 * Usage:
 *   node scripts/release.mjs patch    # 0.5.0 → 0.5.1
 *   node scripts/release.mjs minor    # 0.5.0 → 0.6.0
 *   node scripts/release.mjs major    # 0.5.0 → 1.0.0
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const PKG_PATH = join(ROOT, "package.json");
const OUTPUT_DIR = join(ROOT, ".output");

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf-8" }).trim();
}

// --- Parse args ---
const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

// --- 1. Bump version ---
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const newVersion =
  bump === "major" ? `${major + 1}.0.0` :
  bump === "minor" ? `${major}.${minor + 1}.0` :
  `${major}.${minor}.${patch + 1}`;

console.log(`\n▸ Bumping version: ${pkg.version} → ${newVersion}`);
pkg.version = newVersion;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

// --- 2. Clean old zips and stale build folders ---
console.log(`\n▸ Cleaning .output/`);
if (existsSync(OUTPUT_DIR)) {
  // Remove all old zips
  for (const file of readdirSync(OUTPUT_DIR)) {
    if (file.endsWith(".zip")) {
      unlinkSync(join(OUTPUT_DIR, file));
      console.log(`  Removed old zip: ${file}`);
    }
  }
}

// --- 3. Build + zip all browsers ---
console.log(`\n▸ Building all browsers + zips...`);
run("npm run zip:all");

// --- 4. Verify expected zips exist ---
const EXPECTED = [
  "sc-bridge-sync-chrome.zip",
  "sc-bridge-sync-firefox.zip",
  "sc-bridge-sync-edge.zip",
  "sc-bridge-sync-opera.zip",
  "sc-bridge-sync-sources.zip",
];

console.log(`\n▸ Verifying zips...`);
const missing = EXPECTED.filter((z) => !existsSync(join(OUTPUT_DIR, z)));
if (missing.length > 0) {
  console.error(`\nERROR: Missing zips: ${missing.join(", ")}`);
  process.exit(1);
}

// Verify manifest version matches
const manifest = JSON.parse(readFileSync(join(OUTPUT_DIR, "chrome-mv3", "manifest.json"), "utf-8"));
if (manifest.version !== newVersion) {
  console.error(`\nERROR: Manifest version (${manifest.version}) doesn't match package.json (${newVersion})`);
  process.exit(1);
}
console.log(`  ✓ All 5 zips present, manifest version: ${manifest.version}`);

// --- 5. Commit version bump ---
console.log(`\n▸ Committing version bump...`);
run(`git add package.json package-lock.json`);
run(`git commit -m "chore: bump version to ${newVersion}"`);

// --- 6. Tag ---
console.log(`\n▸ Tagging v${newVersion}...`);
run(`git tag v${newVersion}`);

// --- 7. Push ---
console.log(`\n▸ Pushing to GitHub...`);
run(`git push origin main`);
run(`git push origin v${newVersion}`);

// --- 8. Create GitHub release ---
console.log(`\n▸ Creating GitHub release...`);
const assets = EXPECTED.map((z) => `.output/${z}`).join(" ");
const title = `v${newVersion}`;

// Build release notes from git log since last tag
let prevTag;
try {
  prevTag = runCapture(`git describe --tags --abbrev=0 v${newVersion}^`);
} catch {
  prevTag = null;
}
const logRange = prevTag ? `${prevTag}..v${newVersion}` : `v${newVersion}`;
let commits;
try {
  commits = runCapture(`git log ${logRange} --oneline --no-decorate`);
} catch {
  commits = "(first release)";
}

const notes = `## SC Bridge Sync v${newVersion}

### Commits
${commits.split("\n").map((l) => `- ${l}`).join("\n")}

## Downloads
- **Chrome**: \`sc-bridge-sync-chrome.zip\` — load unpacked at \`chrome://extensions\`
- **Edge**: \`sc-bridge-sync-edge.zip\` — load unpacked at \`edge://extensions\`
- **Firefox**: \`sc-bridge-sync-firefox.zip\` — load temporary at \`about:debugging#/runtime/this-firefox\`
- **Opera**: \`sc-bridge-sync-opera.zip\` — load unpacked at \`opera://extensions\`
- **Sources**: \`sc-bridge-sync-sources.zip\` — full source for store review submissions`;

run(`gh release create v${newVersion} ${assets} --repo SC-Bridge/sc-bridge-sync --title "${title}" --notes "${notes.replace(/"/g, '\\"')}"`);

console.log(`\n✓ Released v${newVersion}`);
console.log(`  https://github.com/SC-Bridge/sc-bridge-sync/releases/tag/v${newVersion}`);
