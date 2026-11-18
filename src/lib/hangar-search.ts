/**
 * Hangar pledge search.
 *
 * A pledge matches when every typed word appears somewhere in its name,
 * item titles, manufacturers or custom ship names. Fuzzy matching is only a
 * typo fallback, used when no pledge contains the text: run on every query
 * it matched "lib" against "Lifetime Insurance" and "Lightning Bolt Co.".
 */

import Fuse from "fuse.js";
import type { RsiPledge } from "./types";

const FUZZY_MIN_QUERY_LENGTH = 3;

function pledgeSearchText(pledge: RsiPledge): string {
  const parts = [pledge.name];
  for (const item of pledge.items) {
    parts.push(item.title, item.manufacturer ?? "", item.customName ?? "");
  }
  return parts.join(" ").toLowerCase();
}

/** Build a search function over a fixed set of pledge entries. */
export function createPledgeSearch<T extends { data: RsiPledge }>(entries: T[]): (query: string) => T[] {
  const indexed = entries.map((entry) => ({ entry, text: pledgeSearchText(entry.data) }));
  let fuse: Fuse<T> | null = null;

  return (query) => {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return entries;

    const words = normalized.split(/\s+/);
    const exact = indexed
      .filter(({ text }) => words.every((word) => text.includes(word)))
      .map(({ entry }) => entry);
    if (exact.length > 0 || normalized.length < FUZZY_MIN_QUERY_LENGTH) return exact;

    fuse ??= new Fuse(entries, {
      keys: [
        { name: "data.name", weight: 2 },
        { name: "data.items.title", weight: 1.5 },
        { name: "data.items.manufacturer", weight: 1 },
        { name: "data.items.customName", weight: 1.5 },
      ],
      threshold: 0.3,
      ignoreLocation: true,
    });
    const index = fuse;
    const fuzzyByWord = words.map((word) =>
      word.length < FUZZY_MIN_QUERY_LENGTH ? null : new Set(index.search(word).map((result) => result.item)),
    );
    return indexed
      .filter(({ entry, text }) =>
        words.every((word, i) => text.includes(word) || fuzzyByWord[i]?.has(entry) === true),
      )
      .map(({ entry }) => entry);
  };
}
