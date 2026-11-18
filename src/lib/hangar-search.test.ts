import { describe, expect, it } from "vitest";
import { createPledgeSearch } from "./hangar-search";
import type { RsiPledge, RsiPledgeItem } from "./types";

function makeEntry(name: string, items: Partial<RsiPledgeItem>[] = []): { data: RsiPledge } {
  return {
    data: {
      id: 1,
      name,
      value: "$0.00 USD",
      valueCents: 0,
      configurationValue: "$0.00 USD",
      currency: "Store Credit",
      date: "May 29, 2014",
      isUpgraded: false,
      isReclaimable: true,
      isGiftable: false,
      hasUpgradeLog: false,
      availability: "Attributed",
      items: items.map((i) => ({ title: "", kind: null, ...i })),
      nameableShips: null,
      nameReservations: null,
      upgradeData: null,
      pledgeImage: null,
      hasLti: false,
      isWarbond: false,
      isReward: false,
      insuranceType: null,
    },
  };
}

const liberator = makeEntry("Standalone Ships - Liberator", [
  { title: "Liberator", kind: "Ship", manufacturer: "Anvil Aerospace" },
  { title: "Lifetime Insurance", kind: "Insurance" },
]);
const zeus = makeEntry("Zeus Mk II ES", [
  { title: "Zeus Mk II ES", kind: "Ship", manufacturer: "Roberts Space Industries" },
  { title: "Lifetime Insurance", kind: "Insurance" },
]);
const pistol = makeEntry('Yubarev "Deadeye" Pistol', [
  { title: 'Lightning Bolt Co. Yubarev "Deadeye" Pistol', kind: "FPS Equipment" },
]);
const lightning = makeEntry("FBC Lightning", [
  { title: "F8C Lightning", kind: "Ship", manufacturer: "Anvil Aerospace", customName: "Stormcrow" },
]);
const all = [liberator, zeus, pistol, lightning];

describe("createPledgeSearch", () => {
  const search = createPledgeSearch(all);

  it("returns only pledges that contain the typed text", () => {
    expect(search("lib")).toEqual([liberator]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(search("  LIBERATOR ")).toEqual([liberator]);
  });

  it("requires every word to match, in any order", () => {
    expect(search("es zeus")).toEqual([zeus]);
    expect(search("zeus lightning")).toEqual([]);
  });

  it("matches item titles, manufacturers and custom names", () => {
    expect(search("bolt")).toEqual([pistol]);
    expect(search("anvil")).toEqual([liberator, lightning]);
    expect(search("stormcrow")).toEqual([lightning]);
  });

  it("matches one and two character queries by substring", () => {
    expect(search("f8")).toEqual([lightning]);
  });

  it("falls back to a fuzzy match only when nothing contains the text", () => {
    expect(search("libertor")).toEqual([liberator]);
  });

  it("returns everything for an empty query", () => {
    expect(search("   ")).toEqual(all);
  });
});
