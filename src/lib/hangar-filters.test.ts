import { describe, expect, it } from "vitest";
import { isPaintItem, parseStoredFilters } from "./hangar-filters";

describe("isPaintItem", () => {
  it("matches items RSI labels as Skin", () => {
    expect(isPaintItem({ title: "Aurora - Ghoulish Green", kind: "Skin" })).toBe(true);
  });

  it("matches unlabelled items whose title names a paint", () => {
    expect(isPaintItem({ title: "Caterpillar - IceBreak Paint", kind: null })).toBe(true);
  });

  it("does not match a painting or a labelled non-paint item", () => {
    expect(isPaintItem({ title: "Takuetsu Painting", kind: null })).toBe(false);
    expect(isPaintItem({ title: "Paint Shop Poster", kind: "Hangar decoration" })).toBe(false);
    expect(isPaintItem({ title: "Gladius", kind: "Ship" })).toBe(false);
  });
});

describe("parseStoredFilters", () => {
  const valid = ["ships", "paints", "lti"] as const;

  it("restores include, exclude and search", () => {
    expect(parseStoredFilters({ include: ["paints"], exclude: ["lti"], search: "aurora" }, valid)).toEqual({
      include: ["paints"],
      exclude: ["lti"],
      search: "aurora",
    });
  });

  it("drops keys that no longer exist and keys in both lists", () => {
    expect(parseStoredFilters({ include: ["ships", "gone"], exclude: ["ships", "lti"], search: "" }, valid)).toEqual({
      include: ["ships"],
      exclude: ["lti"],
      search: "",
    });
  });

  it("returns empty filters for missing or malformed data", () => {
    const empty = { include: [], exclude: [], search: "" };
    expect(parseStoredFilters(undefined, valid)).toEqual(empty);
    expect(parseStoredFilters("ships", valid)).toEqual(empty);
    expect(parseStoredFilters({ include: "ships", exclude: [1], search: 5 }, valid)).toEqual(empty);
  });
});
