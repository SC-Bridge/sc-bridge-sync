/**
 * Pure helpers for the hangar filter toolbar.
 */

import type { RsiPledgeItem } from "./types";

/**
 * RSI labels paints "Skin". Newer products often have no kind element at
 * all, so an unlabelled item counts when its title names a paint — the same
 * rule SC Bridge applies on import. Word boundary so "Painting" stays out.
 */
export function isPaintItem(item: Pick<RsiPledgeItem, "title" | "kind">): boolean {
  if (item.kind === "Skin") return true;
  return item.kind === null && /\bPaint\b/i.test(item.title);
}

export interface StoredFilters<K extends string> {
  include: K[];
  exclude: K[];
  search: string;
}

/**
 * Read saved filter state back from storage. Anything unrecognised is
 * dropped: a filter renamed or removed in a later version must not leave
 * the hangar filtered by a button that no longer exists.
 */
export function parseStoredFilters<K extends string>(raw: unknown, validKeys: readonly K[]): StoredFilters<K> {
  const empty: StoredFilters<K> = { include: [], exclude: [], search: "" };
  if (!raw || typeof raw !== "object") return empty;
  const value = raw as Record<string, unknown>;

  const keys = (list: unknown): K[] =>
    Array.isArray(list) ? [...new Set(list.filter((k): k is K => validKeys.includes(k as K)))] : [];

  const include = keys(value.include);
  const exclude = keys(value.exclude).filter((k) => !include.includes(k));
  const search = typeof value.search === "string" ? value.search : "";
  return { include, exclude, search };
}
