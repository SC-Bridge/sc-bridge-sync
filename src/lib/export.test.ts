import { describe, expect, it } from "vitest";
import { FLAT_CSV_HEADER, pledgeShipNames, toFlatCsv } from "./export";
import type { RsiBuyBackPledge, RsiPledge, RsiPledgeItem } from "./types";

function makePledge(overrides: Partial<RsiPledge> = {}): RsiPledge {
  return {
    id: 2262315,
    name: "Freelancer",
    value: "$440.00 USD",
    valueCents: 44000,
    configurationValue: "$0.00 USD",
    currency: "Store Credit",
    date: "May 29, 2014",
    isUpgraded: true,
    isReclaimable: true,
    isGiftable: false,
    hasUpgradeLog: true,
    availability: "Attributed",
    items: [],
    nameableShips: null,
    nameReservations: null,
    upgradeData: null,
    pledgeImage: null,
    hasLti: true,
    isWarbond: false,
    isReward: false,
    insuranceType: "LTI",
    ...overrides,
  };
}

const ship600i: RsiPledgeItem = {
  title: "600i Exploration Module",
  kind: "Ship",
  manufacturer: "Origin Jumpworks",
  manufacturerCode: "ORIG",
  customName: "Kanuna",
};
const lti: RsiPledgeItem = { title: "Lifetime Insurance", kind: "Insurance" };
const hangar: RsiPledgeItem = { title: "Aeroview Hangar", kind: "Hangar decoration" };

/** Minimal RFC 4180 parser so assertions see cells, not raw text. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function cellsOf(text: string) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

describe("pledgeShipNames", () => {
  it("names each Ship or Vehicle item, custom name first when present", () => {
    const pledge = makePledge({
      items: [lti, ship600i, { title: "G12", kind: "Vehicle" }, hangar],
    });
    expect(pledgeShipNames(pledge)).toEqual(["Kanuna (600i Exploration Module)", "G12"]);
  });

  it("is empty for a pledge with no ships", () => {
    expect(pledgeShipNames(makePledge({ items: [lti, hangar] }))).toEqual([]);
  });
});

describe("toFlatCsv", () => {
  it("starts with a UTF-8 BOM and the header on the first line", () => {
    const csv = toFlatCsv({ pledges: [makePledge({ items: [ship600i] })], buybackPledges: [] });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.replace(/^﻿/, "").split("\n")[0]).toBe(FLAT_CSV_HEADER.join(","));
    expect(FLAT_CSV_HEADER).toEqual([
      "manufacturer", "item", "kind", "custom_name", "lti", "insurance", "warbond",
      "pledge_id", "pledge_name", "value", "date",
      "meltable", "giftable", "upgraded", "availability", "status",
    ]);
  });

  it("writes one row per item with the pledge columns repeated", () => {
    const rows = cellsOf(toFlatCsv({
      pledges: [makePledge({ items: [lti, ship600i, hangar] })],
      buybackPledges: [],
    }));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.item)).toEqual([
      "Lifetime Insurance", "600i Exploration Module", "Aeroview Hangar",
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["Insurance", "Ship", "Hangar decoration"]);
    expect(rows[1]).toMatchObject({
      manufacturer: "Origin Jumpworks",
      custom_name: "Kanuna",
      lti: "true",
      insurance: "LTI",
      warbond: "false",
      pledge_id: "2262315",
      pledge_name: "Freelancer",
      value: "440.00",
      date: "May 29, 2014",
      meltable: "true",
      giftable: "false",
      upgraded: "true",
      availability: "Attributed",
      status: "owned",
    });
    for (const r of rows) {
      expect(r.pledge_id).toBe("2262315");
      expect(r.pledge_name).toBe("Freelancer");
    }
    expect(rows[0].manufacturer).toBe("");
    expect(rows[0].custom_name).toBe("");
  });

  it("keeps a pledge with no items as a single row with blank item columns", () => {
    const rows = cellsOf(toFlatCsv({
      pledges: [makePledge({ id: 99, name: "Empty Reward", items: [] })],
      buybackPledges: [],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pledge_id: "99", pledge_name: "Empty Reward", item: "", kind: "" });
  });

  it("appends buy-back pledges to the same grid with status buyback and unknown pledge flags blank", () => {
    const buyback: RsiBuyBackPledge = {
      id: 102267318,
      name: "Standalone Ships - MOTH",
      value: "$0.00",
      value_cents: 0,
      date: "October 29, 2026",
      items: [{ title: "MOTH", kind: "Ship", manufacturer: "Argo Astronautics" }],
      is_credit_reclaimable: true,
    };
    const rows = cellsOf(toFlatCsv({ pledges: [makePledge({ items: [ship600i] })], buybackPledges: [buyback] }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      manufacturer: "Argo Astronautics",
      item: "MOTH",
      kind: "Ship",
      pledge_id: "102267318",
      pledge_name: "Standalone Ships - MOTH",
      value: "",
      date: "October 29, 2026",
      lti: "",
      warbond: "",
      meltable: "",
      giftable: "",
      upgraded: "",
      availability: "",
      status: "buyback",
    });
  });

  it("is one rectangular grid: no comment or blank lines, every row the header's width", () => {
    const csv = toFlatCsv({
      pledges: [makePledge({ items: [lti, ship600i] }), makePledge({ id: 2, items: [] })],
      buybackPledges: [{
        id: 3, name: "Melted", value: "$0.00", date: "January 1, 2026",
        items: [{ title: "Paint", kind: "Skin" }], is_credit_reclaimable: false,
      }],
    });
    const lines = csv.replace(/^﻿/, "").split("\n");
    expect(lines.some((l) => l.startsWith("#"))).toBe(false);
    expect(lines.some((l) => l.trim() === "")).toBe(false);
    for (const row of parseCsv(csv.replace(/^﻿/, ""))) {
      expect(row).toHaveLength(FLAT_CSV_HEADER.length);
    }
  });

  it("escapes commas, quotes and newlines inside cells", () => {
    const rows = cellsOf(toFlatCsv({
      pledges: [makePledge({
        name: 'Pack, "Deluxe"',
        items: [{ title: "Line one\nLine two", kind: "Other" }],
      })],
      buybackPledges: [],
    }));
    expect(rows[0].pledge_name).toBe('Pack, "Deluxe"');
    expect(rows[0].item).toBe("Line one\nLine two");
  });
});
