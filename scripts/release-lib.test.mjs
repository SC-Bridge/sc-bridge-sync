import { describe, expect, it } from "vitest";
import { buildReleaseNotes, bumpVersion, commitsBetween, previousTag, releaseBranch, resumeHint } from "./release-lib.mjs";

// These run real git against this checkout. Tags v0.6.0 and v0.6.1 exist on
// main; the v0.6.1 release shipped with an empty commit list because the
// shell swallowed the caret in `v0.6.1^` (cmd.exe escape character), so the
// "previous" tag resolved to v0.6.1 itself.
describe("previousTag", () => {
  it("returns the tag before the given tag, not the tag itself", () => {
    expect(previousTag("v0.6.1")).toBe("v0.6.0");
  });

  it("returns null when no earlier tag exists", () => {
    expect(previousTag("v0.3.1")).toBeNull();
  });
});

describe("commitsBetween", () => {
  it("lists the one-line commits in (prev, tag]", () => {
    const lines = commitsBetween("v0.6.0", "v0.6.1");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith("793cdfc "))).toBe(true);
    expect(lines.some((l) => l.startsWith("34b5e5a "))).toBe(true);
    expect(lines.some((l) => l.includes("30x hangar loading speedup"))).toBe(false);
  });
});

describe("buildReleaseNotes", () => {
  it("lists each commit and the five download assets", () => {
    const notes = buildReleaseNotes("1.2.3", ["abc1234 feat: one", "def5678 fix: two"]);
    expect(notes).toContain("## SC Bridge Sync v1.2.3");
    expect(notes).toContain("- abc1234 feat: one\n- def5678 fix: two");
    for (const browser of ["chrome", "firefox", "edge", "opera", "sources"]) {
      expect(notes).toContain(`sc-bridge-sync-${browser}.zip`);
    }
  });

  it("says so when there are no commits instead of printing an empty bullet", () => {
    const notes = buildReleaseNotes("1.2.3", []);
    expect(notes).not.toContain("- \n");
    expect(notes).toContain("(first release)");
  });
});

describe("bumpVersion", () => {
  it("bumps patch, minor and major, resetting the lower parts", () => {
    expect(bumpVersion("0.6.1", "patch")).toBe("0.6.2");
    expect(bumpVersion("0.6.1", "minor")).toBe("0.7.0");
    expect(bumpVersion("0.6.1", "major")).toBe("1.0.0");
  });

  it("rejects an unknown bump kind", () => {
    expect(() => bumpVersion("0.6.1", "huge")).toThrow(/patch\|minor\|major/);
  });
});

describe("releaseBranch", () => {
  it("names the release branch after the new version", () => {
    expect(releaseBranch("0.6.2")).toBe("release/v0.6.2");
  });
});

describe("resumeHint", () => {
  it("tells the operator to merge the PR and run release:publish", () => {
    const hint = resumeHint("0.6.2", "https://github.com/SC-Bridge/sc-bridge-sync/pull/99");
    expect(hint).toContain("https://github.com/SC-Bridge/sc-bridge-sync/pull/99");
    expect(hint).toContain("npm run release:publish");
    expect(hint).toContain("0.6.2");
  });
});
