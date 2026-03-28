/**
 * Export hangar data as JSON or CSV.
 *
 * JSON: Full fidelity nested structure matching SyncPayload.
 * CSV: Flattened one-row-per-item with pledge context on each row.
 */

import type {
  SyncPayload,
  RsiPledge,
  RsiPledgeItem,
  RsiBuyBackPledge,
  RsiUpgrade,
  NamedShip,
  RsiAccountInfo,
} from "./types";
import type { SyncCategoryKey } from "./constants";

export type ExportFormat = "json" | "csv";

/** Filter a sync payload to only include selected categories */
export function filterPayload(
  payload: SyncPayload,
  categories: Record<SyncCategoryKey, boolean>,
): Partial<SyncPayload> {
  const result: Partial<SyncPayload> = {
    sync_meta: payload.sync_meta,
  };

  if (categories.fleet) result.pledges = payload.pledges;
  if (categories.buyback) result.buyback_pledges = payload.buyback_pledges;
  if (categories.upgrades) result.upgrades = payload.upgrades;
  if (categories.account) result.account = payload.account;
  if (categories.shipNames) result.named_ships = payload.named_ships;

  return result;
}

/** Export filtered payload as a JSON string */
export function toJson(payload: Partial<SyncPayload>): string {
  return JSON.stringify(payload, null, 2);
}

/** Export filtered payload as CSV string */
export function toCsv(payload: Partial<SyncPayload>): string {
  const rows: string[][] = [];

  // Pledges → one row per item within each pledge
  if (payload.pledges) {
    const header = [
      "type",
      "pledge_id",
      "pledge_name",
      "pledge_value",
      "pledge_date",
      "currency",
      "is_giftable",
      "is_reclaimable",
      "item_title",
      "item_kind",
      "manufacturer_code",
      "manufacturer_name",
      "custom_name",
      "is_nameable",
    ];
    if (rows.length === 0) rows.push(header);

    for (const pledge of payload.pledges) {
      if (pledge.items.length === 0) {
        rows.push(pledgeRow("pledge", pledge, null));
      } else {
        for (const item of pledge.items) {
          rows.push(pledgeRow("pledge", pledge, item));
        }
      }
    }
  }

  // Buy-back pledges
  if (payload.buyback_pledges) {
    if (rows.length === 0) {
      rows.push([
        "type",
        "pledge_id",
        "pledge_name",
        "pledge_value",
        "pledge_date",
        "currency",
        "is_giftable",
        "is_reclaimable",
        "item_title",
        "item_kind",
        "manufacturer_code",
        "manufacturer_name",
        "custom_name",
        "is_nameable",
      ]);
    }

    for (const pledge of payload.buyback_pledges) {
      if (pledge.items.length === 0) {
        rows.push(buybackRow(pledge, null));
      } else {
        for (const item of pledge.items) {
          rows.push(buybackRow(pledge, item));
        }
      }
    }
  }

  // Upgrades
  if (payload.upgrades && payload.upgrades.length > 0) {
    // Add a blank separator row if we already have pledge rows
    if (rows.length > 1) rows.push([]);

    rows.push(["type", "pledge_id", "upgrade_name", "applied_at", "new_value"]);
    for (const u of payload.upgrades) {
      rows.push([
        "upgrade",
        String(u.pledge_id),
        u.name,
        u.applied_at,
        u.new_value,
      ]);
    }
  }

  // Named ships
  if (payload.named_ships && payload.named_ships.length > 0) {
    if (rows.length > 1) rows.push([]);

    rows.push(["type", "membership_id", "default_name", "custom_name"]);
    for (const s of payload.named_ships) {
      rows.push([
        "named_ship",
        String(s.membership_id),
        s.default_name,
        s.custom_name,
      ]);
    }
  }

  // Account
  if (payload.account) {
    if (rows.length > 1) rows.push([]);

    rows.push(["type", "field", "value"]);
    const a = payload.account;
    const fields: [string, string | number | boolean | undefined][] = [
      ["nickname", a.nickname],
      ["displayname", a.displayname],
      ["enlisted_since", a.enlisted_since],
      ["country", a.country],
      ["concierge_level", a.concierge_level],
      ["concierge_next_level", a.concierge_next_level],
      ["concierge_progress", a.concierge_progress],
      ["subscriber_type", a.subscriber_type],
      ["subscriber_frequency", a.subscriber_frequency],
      ["store_credit_cents", a.store_credit_cents],
      ["uec_balance", a.uec_balance],
      ["rec_balance", a.rec_balance],
      ["org_name", a.org?.name],
      ["org_sid", a.org?.sid],
      ["referral_code", a.referral_code],
      ["has_game_package", a.has_game_package],
    ];
    for (const [field, value] of fields) {
      if (value !== undefined && value !== null) {
        rows.push(["account", field, String(value)]);
      }
    }
  }

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function pledgeRow(
  type: string,
  pledge: RsiPledge,
  item: RsiPledgeItem | null,
): string[] {
  return [
    type,
    String(pledge.id),
    pledge.name,
    pledge.value,
    pledge.date,
    pledge.configurationValue,
    String(pledge.isGiftable),
    String(pledge.isReclaimable),
    item?.title ?? "",
    item?.kind ?? "",
    item?.manufacturerCode ?? "",
    item?.manufacturer ?? "",
    item?.customName ?? "",
    item?.isNameable ? "true" : "false",
  ];
}

function buybackRow(
  pledge: RsiBuyBackPledge,
  item: RsiPledgeItem | null,
): string[] {
  return [
    "buyback",
    String(pledge.id),
    pledge.name,
    pledge.value,
    pledge.date,
    "",
    "false",
    String(pledge.is_credit_reclaimable),
    item?.title ?? "",
    item?.kind ?? "",
    item?.manufacturerCode ?? "",
    item?.manufacturer ?? "",
    item?.customName ?? "",
    item?.isNameable ? "true" : "false",
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
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
