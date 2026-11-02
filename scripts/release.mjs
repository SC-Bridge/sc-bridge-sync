#!/usr/bin/env node
/**
 * Release script — the full release lifecycle through a pull request, so
 * `main`'s "changes must be made through a pull request" rule is honoured
 * instead of bypassed.
 *
 *   node scripts/release.mjs patch|minor|major
 *     1. Preflight: clean tree, on main, main == origin/main
 *     2. Branch release/vX.Y.Z, bump package.json
 *     3. Build + zip all 4 browsers + sources, verify names + manifest version
 *     4. Commit the bump, push the branch, open a PR (body = release notes)
 *     5. Merge the PR with a merge commit (keeps the hook-built bump commit)
 *     6. publish (below)
 *     If step 5 is refused (a review or check becomes required), the script
 *     stops, prints the PR link and `npm run release:publish` to resume.
 *
 *   node scripts/release.mjs publish
 *     6. On main after the bump has merged: pull, rebuild zips from main,
 *        tag vX.Y.Z, push the tag, create the GitHub release with the zips.
 *
 * Usage:
 *   npm run release:patch    # 0.5.0 → 0.5.1
 *   npm run release:minor    # 0.5.0 → 0.6.0
 *   npm run release:major    # 0.5.0 → 1.0.0
 *   npm run release:publish  # finish a release whose PR was merged by hand
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  buildReleaseNotes, bumpVersion, commitsBetween, git, previousTag, releaseBranch, resumeHint,
} from "./release-lib.mjs";

const ROOT = join(import.meta.dirname, "..");
const PKG_PATH = join(ROOT, "package.json");
const OUTPUT_DIR = join(ROOT, ".output");
const REPO = "SC-Bridge/sc-bridge-sync";
const NOTES_PATH = join(OUTPUT_DIR, "release-notes.md");

const EXPECTED = [
  "sc-bridge-sync-chrome.zip",
  "sc-bridge-sync-firefox.zip",
  "sc-bridge-sync-edge.zip",
  "sc-bridge-sync-opera.zip",
  "sc-bridge-sync-sources.zip",
];

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function readVersion() {
  return JSON.parse(readFileSync(PKG_PATH, "utf-8")).version;
}

// --- Preflight: a release starts from a clean, current main ---
function preflight() {
  console.log(`\n▸ Preflight...`);
  if (git(["status", "--porcelain"]) !== "") fail("Working tree is not clean — commit or stash first.");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") fail(`Must run from main (currently on ${branch}).`);
  git(["fetch", "--quiet", "origin", "main"]);
  const local = git(["rev-parse", "main"]);
  const remote = git(["rev-parse", "origin/main"]);
  if (local !== remote) fail("Local main differs from origin/main — pull (or push) first.");
  console.log(`  ✓ clean tree, on main at ${local.slice(0, 7)}, in sync with origin`);
}

// --- Build + verify the five zips for the version in package.json ---
function buildZips(version) {
  console.log(`\n▸ Cleaning .output/`);
  if (existsSync(OUTPUT_DIR)) {
    for (const file of readdirSync(OUTPUT_DIR)) {
      if (file.endsWith(".zip")) {
        unlinkSync(join(OUTPUT_DIR, file));
        console.log(`  Removed old zip: ${file}`);
      }
    }
  }

  console.log(`\n▸ Building all browsers + zips...`);
  run("npm run zip:all");

  console.log(`\n▸ Verifying zips...`);
  const missing = EXPECTED.filter((z) => !existsSync(join(OUTPUT_DIR, z)));
  if (missing.length > 0) fail(`Missing zips: ${missing.join(", ")}`);

  const manifest = JSON.parse(readFileSync(join(OUTPUT_DIR, "chrome-mv3", "manifest.json"), "utf-8"));
  if (manifest.version !== version) {
    fail(`Manifest version (${manifest.version}) doesn't match package.json (${version})`);
  }
  console.log(`  ✓ All 5 zips present, manifest version: ${manifest.version}`);
}

// --- Release notes: commits since the previous tag, written to a file for gh ---
// (a quoted multi-line --notes string via cmd.exe breaks on %, &, ^ and quotes)
function writeNotes(version, tagOrRef) {
  const notes = buildReleaseNotes(version, commitsBetween(previousTag(tagOrRef), tagOrRef));
  writeFileSync(NOTES_PATH, notes + "\n");
  return NOTES_PATH;
}

// --- Steps 1–5: bump on a branch, PR, merge ---
function prepareAndMerge(kind) {
  preflight();

  const current = readVersion();
  const version = bumpVersion(current, kind);
  const branch = releaseBranch(version);
  const tag = `v${version}`;

  if (git(["tag", "--list", tag]) !== "") fail(`Tag ${tag} already exists.`);

  console.log(`\n▸ Bumping version: ${current} → ${version} on ${branch}`);
  git(["checkout", "-b", branch]);
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
  pkg.version = version;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

  buildZips(version);

  console.log(`\n▸ Committing version bump...`);
  run(`git add package.json package-lock.json`);
  run(`git commit -m "chore: release ${tag}"`);

  console.log(`\n▸ Opening release PR...`);
  run(`git push -u origin ${branch}`);
  // Notes for the PR body: everything on this branch since the previous tag
  const notesPath = writeNotes(version, "HEAD");
  run(`gh pr create --repo ${REPO} --base main --head ${branch} --title "chore: release ${tag}" --body-file "${notesPath}"`);
  const prUrl = execSync(`gh pr view ${branch} --repo ${REPO} --json url --jq .url`, { cwd: ROOT, encoding: "utf-8" }).trim();
  console.log(`  ${prUrl}`);

  console.log(`\n▸ Merging release PR (merge commit)...`);
  try {
    run(`gh pr merge ${branch} --repo ${REPO} --merge --delete-branch`);
  } catch {
    git(["checkout", "main"]);
    console.log(`\n${resumeHint(version, prUrl)}`);
    process.exit(2);
  }

  publish(version);
}

// --- Step 6: tag main and create the GitHub release ---
function publish(expectedVersion) {
  console.log(`\n▸ Publishing...`);
  git(["checkout", "main"]);
  run(`git pull --ff-only origin main`);

  const version = readVersion();
  if (expectedVersion && version !== expectedVersion) {
    fail(`main has version ${version}, expected ${expectedVersion} — has the release PR merged?`);
  }
  const tag = `v${version}`;
  if (git(["tag", "--list", tag]) !== "") fail(`Tag ${tag} already exists — nothing to publish.`);
  if (git(["status", "--porcelain"]) !== "") fail("Working tree is not clean.");

  // Rebuild from main so the assets match exactly what was merged
  buildZips(version);

  console.log(`\n▸ Tagging ${tag} on main...`);
  git(["tag", tag]);
  run(`git push origin ${tag}`);

  console.log(`\n▸ Creating GitHub release...`);
  const notesPath = writeNotes(version, tag);
  const assets = EXPECTED.map((z) => `.output/${z}`).join(" ");
  run(`gh release create ${tag} ${assets} --repo ${REPO} --title "${tag}" --notes-file "${notesPath}"`);

  console.log(`\n✓ Released ${tag}`);
  console.log(`  https://github.com/${REPO}/releases/tag/${tag}`);
}

// --- Entry ---
const mode = process.argv[2];
if (mode === "publish") {
  publish(null);
} else if (["patch", "minor", "major"].includes(mode)) {
  prepareAndMerge(mode);
} else {
  console.error("Usage: node scripts/release.mjs <patch|minor|major|publish>");
  process.exit(1);
}
