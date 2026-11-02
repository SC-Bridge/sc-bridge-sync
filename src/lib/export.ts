/**
 * Export helpers for hangar data.
 *
 * CSV is one rectangular grid: header on row 1, one row per item, no
 * section comments or blank separators, so spreadsheet importers treat
 * it as a table. Buy-back pledges share the grid via the `status` column.
 */

import type { RsiBuyBackPledge, RsiPledge, RsiPledgeItem } from "./types";

const SHIP_KINDS = new Set(["Ship", "Vehicle"]);

/**
 * Names of the ships/vehicles inside a pledge — what the pledge actually
 * contains now, not the pledge title (which never changes across CCUs).
 * Custom names lead: "Kanuna (600i Exploration Module)".
 */
export function pledgeShipNames(pledge: Pick<RsiPledge, "items">): string[] {
  return shipItems(pledge).map((i) =>
    i.customName ? `${i.customName} (${i.title})` : i.title,
  );
}

/** The Ship/Vehicle items of a pledge, in RSI order. */
export function shipItems(pledge: Pick<RsiPledge, "items">): RsiPledgeItem[] {
  return pledge.items.filter((i) => i.kind !== null && SHIP_KINDS.has(i.kind));
}

export const FLAT_CSV_HEADER = [
  "manufacturer", "item", "kind", "custom_name", "lti", "insurance", "warbond",
  "pledge_id", "pledge_name", "value", "date",
  "meltable", "giftable", "upgraded", "availability", "status",
] as const;

export interface FlatCsvInput {
  pledges: RsiPledge[];
  buybackPledges: RsiBuyBackPledge[];
}

/** Export owned and buy-back pledges as a single flat CSV (UTF-8 with BOM). */
export function toFlatCsv({ pledges, buybackPledges }: FlatCsvInput): string {
  const rows: string[][] = [[...FLAT_CSV_HEADER]];

  for (const pledge of pledges) {
    const pledgeCols = [
      String(pledge.hasLti),
      pledge.insuranceType ?? "",
      String(pledge.isWarbond),
      String(pledge.id),
      pledge.name,
      (pledge.valueCents / 100).toFixed(2),
      pledge.date,
      String(pledge.isReclaimable),
      String(pledge.isGiftable),
      String(pledge.isUpgraded),
      pledge.availability,
      "owned",
    ];
    for (const item of itemsOrPlaceholder(pledge.items)) {
      rows.push([...itemCols(item), ...pledgeCols]);
    }
  }

  for (const pledge of buybackPledges) {
    const pledgeCols = [
      "", "", "",
      String(pledge.id),
      pledge.name,
      pledge.value_cents ? (pledge.value_cents / 100).toFixed(2) : "",
      pledge.date,
      "", "", "", "",
      "buyback",
    ];
    for (const item of itemsOrPlaceholder(pledge.items)) {
      rows.push([...itemCols(item), ...pledgeCols]);
    }
  }

  return "﻿" + rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

/** A pledge with no parsed items still gets one row so it is never lost. */
function itemsOrPlaceholder(items: RsiPledgeItem[]): (RsiPledgeItem | null)[] {
  return items.length > 0 ? items : [null];
}

function itemCols(item: RsiPledgeItem | null): string[] {
  return [
    item?.manufacturer ?? "",
    item?.title ?? "",
    item?.kind ?? "",
    item?.customName ?? "",
  ];
}

/** Escape a CSV value — wrap in quotes if it contains commas, quotes, or newlines */
export function csvEscape(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Trigger a file download in the browser */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string,
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } catch {
    // Programmatic click failed (e.g. sandboxed context) — try downloads API
    if (browser.downloads?.download) {
      browser.downloads.download({ url, filename, saveAs: true }).catch((err) => {
        console.error("[downloadFile] browser.downloads.download failed:", err);
      });
      return; // don't revoke URL yet — downloads API needs it
    }
    console.error(
      "[downloadFile] Programmatic click failed and browser.downloads API unavailable. " +
      "Try right-clicking the export button and using 'Save link as...'.",
    );
  }

  URL.revokeObjectURL(url);
}
