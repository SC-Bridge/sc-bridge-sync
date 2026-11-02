/**
 * Pure-ish helpers for scripts/release.mjs, kept separate so they can be
 * unit-tested. Git is invoked with execFileSync (no shell) because the
 * release script runs on Windows, where cmd.exe treats `^` as an escape
 * character and turned `v0.6.1^` into `v0.6.1`.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const ZIP_ASSETS = [
  ["Chrome", "sc-bridge-sync-chrome.zip", "load unpacked at `chrome://extensions`"],
  ["Edge", "sc-bridge-sync-edge.zip", "load unpacked at `edge://extensions`"],
  ["Firefox", "sc-bridge-sync-firefox.zip", "load temporary at `about:debugging#/runtime/this-firefox`"],
  ["Opera", "sc-bridge-sync-opera.zip", "load unpacked at `opera://extensions`"],
  ["Sources", "sc-bridge-sync-sources.zip", "full source for store review submissions"],
];

const BUMP_KINDS = ["patch", "minor", "major"];

/** Next semver for a bump kind; lower parts reset to 0. */
export function bumpVersion(version, kind) {
  if (!BUMP_KINDS.includes(kind)) {
    throw new Error(`Unknown bump "${kind}" — expected patch|minor|major`);
  }
  const [major, minor, patch] = version.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Branch the version bump travels on before it reaches main through a PR. */
export function releaseBranch(version) {
  return `release/v${version}`;
}

/** What to tell the operator when the release PR could not be merged automatically. */
export function resumeHint(version, prUrl) {
  return [
    `The release PR for v${version} is open but could not be merged automatically:`,
    `  ${prUrl}`,
    `Merge it (merge commit), then finish the release with:`,
    `  npm run release:publish`,
  ].join("\n");
}

/** Run git with an argument list (never a shell string) and return trimmed stdout. */
export function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The most recent tag reachable from the commit before `tag`, or null if none. */
export function previousTag(tag) {
  try {
    return git(["describe", "--tags", "--abbrev=0", `${tag}~1`]);
  } catch {
    return null;
  }
}

/** One-line commits in (prevTag, tag]; the whole history up to `tag` when prevTag is null. */
export function commitsBetween(prevTag, tag) {
  const range = prevTag ? `${prevTag}..${tag}` : tag;
  const out = git(["log", range, "--oneline", "--no-decorate"]);
  return out ? out.split("\n") : [];
}

/** Markdown body for the GitHub release. */
export function buildReleaseNotes(version, commits) {
  const commitLines = commits.length > 0
    ? commits.map((l) => `- ${l}`).join("\n")
    : "(first release)";
  const downloads = ZIP_ASSETS
    .map(([label, file, how]) => `- **${label}**: \`${file}\` — ${how}`)
    .join("\n");
  return `## SC Bridge Sync v${version}

### Commits
${commitLines}

## Downloads
${downloads}`;
}
