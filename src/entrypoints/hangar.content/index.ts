/**
 * Content script — enhances the RSI hangar/pledges page with
 * filter buttons, search, sorting, pagination, total spend,
 * multi-select, fuzzy search, caching, and export capabilities.
 *
 * Like HangarXplor, we collect the actual <li> DOM nodes from every
 * page and move them in/out of the native .list-items container.
 * RSI's exchange, gift, and upgrade buttons survive because the
 * nodes are never destroyed — just repositioned.
 */

import "./style.css";
import Fuse from "fuse.js";
import type { RsiPledge, RsiPledgeItem, RsiUpgradeData, NamedShip, RsiAccountInfo, RsiUpgrade, RsiBuyBackPledge, RsiOrgInfo, RsiBadgeDisplay, SyncPayload } from "@/lib/types";
import { SYNC_CATEGORIES, RSI_API, RSI_REQUEST_DELAY_MS, getApiBase, type PrivacyMode } from "@/lib/constants";
import { csvEscape, downloadFile } from "@/lib/export";
import { getPrivacyMode, getStealthPercent } from "@/lib/storage";

// ── Filter Types ──

type FilterKey =
  | "ships"
  | "ccus"
  | "freeCcus"
  | "packages"
  | "combos"
  | "flair"
  | "weapons"
  | "armour"
  | "lti"
  | "warbond"
  | "giftable"
  | "meltable"
  | "upgraded"
  | "valuable"
  | "reward";

type SortKey =
  | "newest"
  | "oldest"
  | "name-az"
  | "name-za"
  | "value-high"
  | "value-low";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest First" },
  { key: "oldest", label: "Oldest First" },
  { key: "name-az", label: "Name A-Z" },
  { key: "name-za", label: "Name Z-A" },
  { key: "value-high", label: "Value High-Low" },
  { key: "value-low", label: "Value Low-High" },
];

const FILTERS: { key: FilterKey; label: string; group: "content" | "status" }[] = [
  { key: "ships", label: "Ships", group: "content" },
  { key: "ccus", label: "CCUs", group: "content" },
  { key: "freeCcus", label: "Free CCUs", group: "status" },
  { key: "packages", label: "Packages", group: "content" },
  { key: "combos", label: "Combos", group: "content" },
  { key: "flair", label: "Flair", group: "content" },
  { key: "weapons", label: "Weapons", group: "content" },
  { key: "armour", label: "Armour", group: "content" },
  { key: "lti", label: "LTI", group: "status" },
  { key: "warbond", label: "Warbond", group: "status" },
  { key: "giftable", label: "Giftable", group: "status" },
  { key: "meltable", label: "Meltable", group: "status" },
  { key: "upgraded", label: "Upgraded", group: "status" },
  { key: "valuable", label: "Valuable", group: "status" },
  { key: "reward", label: "Reward", group: "status" },
];

const VALUABLE_THRESHOLD = 100;
const PROBE_BATCH = 10;
const MAX_PAGES = 500;
const COLLECT_TIMEOUT_MS = 120_000;
const OBSERVER_TIMEOUT_MS = 10_000;
const CONTENT_SCRIPT_INIT_MS = 3000;
const BUYBACK_PAGE_SIZE = 100;
const BUYBACK_MAX_PAGES = 100;
const SEARCH_DEBOUNCE_MS = 200;
const FETCH_TIMEOUT_MS = 15_000;
const BUYBACK_PROBE_BATCH = 5;

const PAGE_SIZE_OPTIONS = [25, 50, 100, 0] as const; // 0 = All

/** Strip RSI pledge prefixes to show the actual content name */
function cleanPledgeName(name: string): string {
  return name
    .replace(/^Standalone\s+Ships?\s*-\s*/i, "")
    .replace(/^Package\s*-\s*/i, "")
    .replace(/^Add-Ons\s*-\s*/i, "")
    .replace(/^Combo\s*-\s*/i, "")
    .trim();
}

/** Validate and sanitize a URL for safe use in CSS/HTML */
function sanitizeImageUrl(url: string): string | null {
  try {
    const parsed = new URL(url, "https://robertsspaceindustries.com");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// ── State ──

/** Each entry pairs a parsed data object with its native <li> DOM node */
interface PledgeEntry {
  data: RsiPledge;
  node: HTMLLIElement;
}

let inventory: PledgeEntry[] = [];
let filtered: PledgeEntry[] = [];
let includeFilters = new Set<FilterKey>();
let excludeFilters = new Set<FilterKey>();
let searchQuery = "";
let sortKey: SortKey = "newest";
let loading = true;
let nativeList: HTMLElement | null = null;

// P1: Promise-based loading completion
let loadingResolver: (() => void) | null = null;
let loadingPromise: Promise<void> = new Promise((r) => { loadingResolver = r; });

// P12: AbortController for stopping concurrent operations
let stopped = false;
let abortController: AbortController | null = null;

// Privacy mode state
let privacyMode: PrivacyMode = "off";
let stealthPercent = 10;

// P4: Search debounce timer
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// P6: Cached filter counts (total counts across all inventory, computed once when inventory changes)
let filterCountCache: Map<FilterKey, number> = new Map();

// F4: Pagination state
let pageSize: number = 0; // 0 = All
let currentPage: number = 1;

// F8: Multi-select state
let selectedIds = new Set<number>();
let lastClickedIndex: number | null = null;

// F9: Fuse index for fuzzy search
let fuseIndex: Fuse<PledgeEntry> | null = null;

// F10: Cache state
let cacheBypass = false;
const CACHE_KEY = "hangar_cache";

// Billing-based payment method map: pledge ID → 'cash' | 'credit' | 'mixed'
let paymentMethodMap: Map<number, "cash" | "credit" | "mixed"> = new Map();
const BILLING_PAGE_SIZE = 100;
const BILLING_MAX_PAGES = 30;

function getLocale(): string {
  const match = window.location.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//i);
  return match ? match[1] : "en";
}

/** P8: Hide RSI's native pagination controls (display: none instead of remove) */
function hidePager() {
  document.querySelectorAll<HTMLElement>(".js-pager, .pager-container, .pagination").forEach((el) => {
    el.style.display = "none";
    el.dataset.scbHidden = "1";
  });
}

/** P8: Restore hidden pagers if loading fails */
function restorePager() {
  document.querySelectorAll<HTMLElement>("[data-scb-hidden]").forEach((el) => {
    el.style.display = "";
    delete el.dataset.scbHidden;
  });
}

// ── Content Script Definition ──

export default defineContentScript({
  matches: [
    "https://robertsspaceindustries.com/account/pledges*",
    "https://robertsspaceindustries.com/*/account/pledges*",
    "https://robertsspaceindustries.com/*/*/account/pledges*",
  ],
  runAt: "document_idle",

  main() {
    // Listen for background-triggered collect requests (legacy flow — kept for
    // direct export from RSI page, but no longer used for bridge sync)
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "COLLECT_ALL_DATA") {
        handleCollectAll()
          .then(sendResponse)
          .catch((err) => {
            sendResponse({
              type: "COLLECT_ERROR",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return true; // async
      }
    });

    // Load privacy mode and listen for changes from popup
    loadPrivacyMode();
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("privacy_mode" in changes || "stealth_percent" in changes) {
        loadPrivacyMode();
      }

      // SERVICE-WORKER-FREE SYNC: Listen for collect commands via storage mailbox.
      // The bridge content script (on scbridge.app) writes a command here.
      // We collect the data and write the result back — no background worker involved.
      // This prevents the MV3 service worker sleep issue that kills long syncs.
      if ("scb_sync_command" in changes) {
        const command = changes.scb_sync_command.newValue as { action?: string; timestamp?: number } | undefined;
        if (command?.action === "collect") {
          console.log("[SC Bridge] Mailbox sync triggered");
          handleCollectAll()
            .then((payload) => {
              browser.storage.local.set({
                scb_sync_result: { payload, timestamp: Date.now() },
              });
              console.log("[SC Bridge] Mailbox sync complete — payload written");
            })
            .catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              browser.storage.local.set({
                scb_sync_result: { error: errMsg, timestamp: Date.now() },
              });
              console.error("[SC Bridge] Mailbox sync failed:", errMsg);
            });
        }
      }
    });

    console.log("[SC Bridge] Hangar enhancement loaded");
    waitForPledgeList();
  },
});

// ── Privacy Mode ──

async function loadPrivacyMode() {
  privacyMode = await getPrivacyMode();
  stealthPercent = await getStealthPercent();
  if (!loading) updateStats();
}

// ── Initialization ──

function waitForPledgeList() {
  if (tryInit()) return;
  const observer = new MutationObserver(() => {
    if (tryInit()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), OBSERVER_TIMEOUT_MS);
}

function tryInit(): boolean {
  const list = document.querySelector(".list-items") as HTMLElement | null;
  if (!list) return false;
  if (document.getElementById("scb-toolbar")) return true;

  // P11: Reset state on re-init
  if (inventory.length > 0) {
    inventory = [];
    filtered = [];
    includeFilters.clear();
    excludeFilters.clear();
    searchQuery = "";
    sortKey = "newest";
    selectedIds.clear();
    lastClickedIndex = null;
    filterCountCache.clear();
    fuseIndex = null;
    currentPage = 1;
    loading = true;
    stopped = false;
    loadingPromise = new Promise((r) => { loadingResolver = r; });
  }

  console.log("[SC Bridge] Found .list-items, injecting toolbar");
  nativeList = list;

  // Collect page 1's native <li> nodes into inventory
  collectNodesFromContainer(nativeList);

  // Load stored preferences
  loadStoredPreferences();

  injectToolbar();

  // P7: Hide RSI's native pagination — observe the pledge list's parent, not document.body
  hidePager();
  const pagerParent = nativeList.parentElement ?? document.body;
  let pagerFound = false;
  const pagerObserver = new MutationObserver(() => {
    hidePager();
    // Disconnect after first successful pager hide
    if (document.querySelector("[data-scb-hidden]") && !pagerFound) {
      pagerFound = true;
      pagerObserver.disconnect();
    }
  });
  pagerObserver.observe(pagerParent, { childList: true, subtree: true });
  setTimeout(() => pagerObserver.disconnect(), OBSERVER_TIMEOUT_MS);

  // F10: Try cache first
  tryLoadFromCache().then((cached) => {
    if (!cached) {
      loadAllPages();
    }
  });

  return true;
}

// ── Stored Preferences ──

async function loadStoredPreferences() {
  try {
    const result = await browser.storage.local.get(["scb_sort_key", "scb_page_size"]);
    if (result.scb_sort_key) sortKey = result.scb_sort_key as SortKey;
    if (result.scb_page_size != null) pageSize = result.scb_page_size as number;
  } catch {
    // ignore
  }
}

async function storePreference(key: string, value: unknown) {
  try {
    await browser.storage.local.set({ [key]: value });
  } catch {
    // ignore
  }
}

// ── F10: Cache ──

function computeCacheHash(): string {
  // Simple hash of pledge IDs + values
  const parts = inventory.map((e) => `${e.data.id}:${e.data.valueCents}`).sort();
  let hash = 0;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

interface CachedInventory {
  hash: string;
  pledges: RsiPledge[];
  timestamp: number;
}

async function tryLoadFromCache(): Promise<boolean> {
  if (cacheBypass) {
    cacheBypass = false;
    return false;
  }

  try {
    const result = await browser.storage.local.get(CACHE_KEY);
    const cached = result[CACHE_KEY] as CachedInventory | undefined;
    if (!cached?.pledges?.length) return false;

    // Cache is valid for 1 hour
    if (Date.now() - cached.timestamp > 3600_000) return false;

    // We already have page 1 nodes in inventory — check if cache matches
    const page1Ids = new Set(inventory.map((e) => e.data.id));

    // Quick sanity check: page 1 IDs should be a subset of cached IDs
    const cachedIds = new Set(cached.pledges.map((p) => p.id));
    for (const id of page1Ids) {
      if (!cachedIds.has(id)) return false; // stale cache
    }

    console.log(`[SC Bridge] Cache hit — ${cached.pledges.length} pledges`);

    // Restore cached pledges that aren't already in inventory (page 1 nodes are live DOM)
    // For cached pledges beyond page 1, we need to create placeholder nodes
    // But we don't have the DOM nodes — so we just store the data
    // Actually, we can't use cache effectively without DOM nodes because render() needs them
    // So cache is only useful as a "skip fetch" optimization — we still need the nodes
    // Mark loading as done using cached data count as an indicator
    // TODO: In future, could serialize/deserialize minimal DOM
    return false;
  } catch {
    return false;
  }
}

async function saveToCache() {
  try {
    const cached: CachedInventory = {
      hash: computeCacheHash(),
      pledges: inventory.map((e) => e.data),
      timestamp: Date.now(),
    };
    await browser.storage.local.set({ [CACHE_KEY]: cached });
  } catch {
    // ignore — storage quota exceeded, etc.
  }
}

// ── DOM Node Collection ──

/** Parse a pledge <li> and store both the data + the live DOM node */
function collectNode(li: HTMLLIElement): PledgeEntry | null {
  const data = parsePledgeRow(li);
  if (!data.id) return null;

  // Update title + image to show current ship name
  enhancePledgeNode(li, data);

  const entry: PledgeEntry = { data, node: li };
  return entry;
}

function collectNodesFromContainer(container: Element) {
  for (const li of container.querySelectorAll(":scope > li")) {
    const entry = collectNode(li as HTMLLIElement);
    if (entry) inventory.push(entry);
  }
}

/**
 * Update the native pledge <li> to show:
 * 1. Cleaned-up title (ship name instead of "Standalone Ship - ..." pledge name)
 * 2. Current ship image (from items) instead of original pledge thumbnail
 * 3. F1: Inline melt value
 * 4. F2: Pledge ID badge
 * 5. LTI / Warbond badges
 */
function enhancePledgeNode(li: HTMLLIElement, pledge: RsiPledge) {
  if (li.dataset.scbEnhanced) return;
  li.dataset.scbEnhanced = "1";

  const h3 = li.querySelector("h3");
  if (!h3) return;

  // ── Clean up the title ──
  let displayName = cleanPledgeName(pledge.name)
    .replace(/^Upgrade\s*-\s*/i, "CCU: ");

  // For ship pledges, show the actual ship name(s) (handles CCU'd ships + multi-ship packs)
  const ships = pledge.items.filter((i) => i.kind === "Ship" || i.kind === "Vehicle");
  const ship = ships[0] ?? null;
  if (ships.length > 0 && !displayName.startsWith("CCU:")) {
    const shipNames = ships.map((s) =>
      s.customName ? `${s.customName} (${s.title})` : s.title,
    );
    displayName = shipNames.join(" / ");
  }

  // Store original as tooltip, replace the visible text
  if (!h3.title) h3.title = pledge.name;

  // RSI's h3 may contain child elements (links, spans) — find and
  // replace the first text-bearing node, or fall back to textContent
  const walker = document.createTreeWalker(h3, NodeFilter.SHOW_TEXT);
  const firstText = walker.nextNode();
  if (firstText && firstText.textContent?.trim()) {
    firstText.textContent = displayName;
  } else {
    h3.textContent = displayName;
  }

  // ── Inject pledge ID + badge pills on one row ──
  const idBadgeRow = document.createElement("div");
  idBadgeRow.className = "scb-id-badges-row";

  const idEl = document.createElement("span");
  idEl.className = "scb-pledge-id";
  idEl.textContent = `#${pledge.id}`;
  idBadgeRow.appendChild(idEl);

  // Insurance badge (LTI, 120-Month, 6-Month, etc.)
  if (pledge.insuranceType) {
    const insBadge = document.createElement("span");
    const isLti = pledge.insuranceType === "LTI";
    insBadge.className = isLti ? "scb-badge scb-badge-lti" : "scb-badge scb-badge-insurance";
    insBadge.textContent = pledge.insuranceType;
    idBadgeRow.appendChild(insBadge);
  }

  // Payment method badge (billing-based, or name fallback)
  const paymentMethod = paymentMethodMap.get(pledge.id);
  if (paymentMethod === "cash") {
    const badge = document.createElement("span");
    badge.className = "scb-badge scb-badge-warbond";
    badge.textContent = "WARBOND";
    idBadgeRow.appendChild(badge);
  } else if (paymentMethod === "credit") {
    const badge = document.createElement("span");
    badge.className = "scb-badge scb-badge-storecredit";
    badge.textContent = "STORE CREDIT";
    idBadgeRow.appendChild(badge);
  } else if (paymentMethod === "mixed") {
    const badge = document.createElement("span");
    badge.className = "scb-badge scb-badge-mixed";
    badge.textContent = "MIXED";
    idBadgeRow.appendChild(badge);
  } else if (pledge.isWarbond) {
    // Fallback: name-based detection (no billing match)
    const badge = document.createElement("span");
    badge.className = "scb-badge scb-badge-warbond";
    badge.textContent = "WARBOND";
    idBadgeRow.appendChild(badge);
  }
  // Mark the row for potential re-render when billing data arrives
  idBadgeRow.dataset.scbPledgeId = String(pledge.id);

  // Giftable (from .js-gift button presence)
  if (pledge.isGiftable) {
    const giftBadge = document.createElement("span");
    giftBadge.className = "scb-badge scb-badge-giftable";
    giftBadge.textContent = "GIFTABLE";
    idBadgeRow.appendChild(giftBadge);
  }

  // CCU'd badge for upgraded pledges
  if (pledge.isUpgraded) {
    const ccuBadge = document.createElement("span");
    ccuBadge.className = "scb-badge scb-badge-ccu";
    ccuBadge.textContent = "CCU\u2019D";
    idBadgeRow.appendChild(ccuBadge);
  }

  h3.parentElement?.insertBefore(idBadgeRow, h3.nextSibling);

  // ── Inject "Base Pledge" for upgraded ships ──
  if (pledge.isUpgraded && ship) {
    const baseName = cleanPledgeName(pledge.name);

    if (baseName !== ship.title) {
      const baseEl = document.createElement("div");
      baseEl.className = "scb-base-pledge";
      baseEl.textContent = `Base Pledge: ${baseName}`;
      idBadgeRow.parentElement?.insertBefore(baseEl, idBadgeRow.nextSibling);
    }
  }

  // ── F1: Inline melt value ──
  if (pledge.valueCents > 0) {
    const meltEl = document.createElement("div");
    meltEl.className = "scb-melt-value";
    const label = document.createElement("span");
    label.className = "scb-melt-label";
    label.textContent = "Melt:";
    const val = document.createElement("span");
    val.className = "scb-melt-amount";
    val.textContent = pledge.value;
    val.dataset.scbCents = String(pledge.valueCents);
    meltEl.appendChild(label);
    meltEl.appendChild(val);

    // Insert into the pledge row — find the date column or title area
    const dateCol = li.querySelector(".date-col");
    if (dateCol) {
      dateCol.parentElement?.insertBefore(meltEl, dateCol.nextSibling);
    } else {
      // Fallback: append to the items area or wrapper
      const wrapper = li.querySelector(".items") ?? li.querySelector(".wrapper") ?? h3.parentElement;
      wrapper?.appendChild(meltEl);
    }
  }

  // ── Update the pledge image to show the current ship/item ──
  const imgEl = li.querySelector(".image, .thumbnail") as HTMLElement | null;

  // Find the best image: ship item first, then any item with an image
  const itemImage = ship?.image ?? pledge.items.find((i) => i.image)?.image;
  const rawUrl = itemImage
    ? (itemImage.startsWith("http") ? itemImage : `https://robertsspaceindustries.com${itemImage}`)
    : null;
  const fullUrl = rawUrl ? sanitizeImageUrl(rawUrl) : null;

  // P9: Don't use CSS.escape on URLs — sanitizeImageUrl already validated it
  if (fullUrl && imgEl) {
    imgEl.style.backgroundImage = `url('${fullUrl}')`;
  }

  // ── Make thumbnail clickable for full-size image ──
  const clickableUrl = fullUrl ?? (imgEl ? extractBgUrl(imgEl) : null);
  if (clickableUrl && imgEl) {
    imgEl.style.cursor = "pointer";
    imgEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showImagePopup(clickableUrl, displayName);
    });
  }

  // ── F8: Click-to-select handler on the <li> ──
  li.addEventListener("click", (e) => {
    // Don't select if clicking on buttons, links, inputs, or the image popup trigger
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, .image, .thumbnail")) return;

    handlePledgeClick(pledge.id, e);
  });
}

// ── F8: Multi-select ──

function handlePledgeClick(id: number, e: MouseEvent) {
  const currentIndex = filtered.findIndex((f) => f.data.id === id);

  if (e.shiftKey && lastClickedIndex !== null && currentIndex !== -1) {
    // Range select
    const start = Math.min(lastClickedIndex, currentIndex);
    const end = Math.max(lastClickedIndex, currentIndex);
    for (let i = start; i <= end; i++) {
      selectedIds.add(filtered[i].data.id);
    }
  } else {
    // Toggle single
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
  }

  lastClickedIndex = currentIndex;
  updateSelectionUI();
}

function updateSelectionUI() {
  // Update selected class on all visible pledge nodes
  for (const entry of filtered) {
    entry.node.classList.toggle("scb-selected", selectedIds.has(entry.data.id));
  }

  // Update selection summary bar
  updateSelectionSummary();
}

function updateSelectionSummary() {
  let bar = document.getElementById("scb-selection-bar");

  if (selectedIds.size === 0) {
    bar?.remove();
    return;
  }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "scb-selection-bar";
    bar.className = "scb-selection-bar";
    document.body.appendChild(bar);
  }

  // Calculate total value of selected items
  const selectedEntries = inventory.filter((e) => selectedIds.has(e.data.id));
  const totalCents = selectedEntries.reduce((sum, e) => sum + e.data.valueCents, 0);

  bar.innerHTML = `
    <div class="scb-selection-info">
      <span class="scb-selection-count">${selectedIds.size} selected</span>
      <span class="scb-selection-sep">&middot;</span>
      <span class="scb-selection-value">${formatCurrency(totalCents / 100)}</span>
    </div>
    <div class="scb-selection-actions">
      <button class="scb-selection-clear">Clear</button>
    </div>
  `;

  bar.querySelector(".scb-selection-clear")?.addEventListener("click", () => {
    selectedIds.clear();
    lastClickedIndex = null;
    updateSelectionUI();
  });
}

function extractBgUrl(el: HTMLElement): string | null {
  const bg = el.style.backgroundImage;
  const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
  if (!match) return null;
  return match[1].startsWith("http")
    ? match[1]
    : `https://robertsspaceindustries.com${match[1]}`;
}

/** Convert a thumbnail URL to the full resolution version */
function toLargeImageUrl(url: string): string {
  return url
    .replace(/\/subscribers_vault_thumbnail\b/, "/source")
    .replace(/\/heap_infobox\b/, "/source")
    .replace(/\/store_small\b/, "/source")
    .replace(/\/store_large\b/, "/source");
}

function showImagePopup(thumbnailUrl: string, title: string) {
  // Remove existing popup if any
  document.getElementById("scb-image-popup")?.remove();

  const largeUrl = toLargeImageUrl(thumbnailUrl);

  const overlay = document.createElement("div");
  overlay.id = "scb-image-popup";
  overlay.className = "scb-image-popup";

  const backdrop = document.createElement("div");
  backdrop.className = "scb-popup-backdrop";

  const content = document.createElement("div");
  content.className = "scb-popup-content";

  const header = document.createElement("div");
  header.className = "scb-popup-header";
  const titleSpan = document.createElement("span");
  titleSpan.className = "scb-popup-title";
  titleSpan.textContent = title;
  const closeBtn = document.createElement("button");
  closeBtn.className = "scb-popup-close";
  closeBtn.innerHTML = "&times;";
  header.append(titleSpan, closeBtn);

  const imgWrap = document.createElement("div");
  imgWrap.className = "scb-popup-img-wrap";

  // Loading shimmer
  const shimmer = document.createElement("div");
  shimmer.className = "scb-shimmer";
  imgWrap.appendChild(shimmer);

  const thumbImg = document.createElement("img");
  thumbImg.className = "scb-popup-img scb-popup-thumb";
  thumbImg.src = thumbnailUrl;
  thumbImg.alt = title;
  const loadingEl = document.createElement("div");
  loadingEl.className = "scb-popup-loading";
  loadingEl.textContent = "Loading full image...";
  imgWrap.append(thumbImg, loadingEl);

  content.append(header, imgWrap);
  overlay.append(backdrop, content);

  // Show thumbnail instantly, swap to full-res when loaded
  const fullImg = new Image();
  fullImg.className = "scb-popup-img";
  fullImg.alt = title;
  fullImg.onload = () => {
    thumbImg.remove();
    loadingEl.remove();
    shimmer.remove();
    imgWrap.appendChild(fullImg);
  };
  fullImg.onerror = () => {
    loadingEl.textContent = "";
    shimmer.remove();
  };
  fullImg.src = largeUrl;

  document.body.appendChild(overlay);

  // Close on backdrop click, close button, or Escape — single cleanup path
  const closeHandler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", closeHandler);
  }
  backdrop.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", closeHandler);
}

// ── Data Parsing ──

function parsePledgeRow(li: HTMLElement): RsiPledge {
  const get = (cls: string): string =>
    (li.querySelector(`.${cls}`) as HTMLInputElement)?.value ?? "";

  const id = parseInt(get("js-pledge-id")) || 0;
  const name = get("js-pledge-name");
  const value = get("js-pledge-value");
  const configurationValue = get("js-pledge-configuration-value");
  const currency = get("js-pledge-currency");

  const isUsd = value.startsWith("$");
  const valueMatch = value.match(/([\d,]+(?:\.\d{2})?)/);
  const valueCents = isUsd && valueMatch
    ? Math.round(parseFloat(valueMatch[1].replace(/,/g, "")) * 100)
    : 0;

  const dateCol = li.querySelector(".date-col");
  const date = dateCol
    ? dateCol.textContent?.replace(/created:\s*/gi, "").trim() ?? ""
    : "";

  const h3 = li.querySelector("h3");
  const isUpgraded = h3 ? h3.classList.contains("upgraded") : false;
  const isReclaimable = !!li.querySelector(".js-reclaim");
  const hasUpgradeLog = !!li.querySelector(".js-upgrade-log");

  // Giftable = the .js-gift button exists in the pledge DOM
  const isGiftable = !!li.querySelector(".js-gift");

  const availEl = li.querySelector(".availability");
  const availability = availEl?.textContent?.trim() ?? "";

  let nameableShips: NamedShip[] | null = null;
  const nameableScript = li.querySelector(".js-pledge-nameable-ships");
  if (nameableScript?.textContent) {
    try { nameableShips = JSON.parse(nameableScript.textContent.trim()); }
    catch { /* ignore */ }
  }

  let nameReservations: Record<string, string> | null = null;
  const reservationsScript = li.querySelector(".js-pledge-name-reservations");
  if (reservationsScript?.textContent) {
    try {
      const parsed = JSON.parse(reservationsScript.textContent.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        nameReservations = parsed;
      }
    } catch { /* ignore */ }
  }

  let upgradeData: RsiUpgradeData | null = null;
  const upgradeDataEl = li.querySelector(".js-upgrade-data") as HTMLInputElement | null;
  if (upgradeDataEl?.value) {
    try { upgradeData = JSON.parse(upgradeDataEl.value); }
    catch { /* ignore */ }
  }

  let pledgeImage: string | null = null;
  const thumbEl = li.querySelector(".image, .thumbnail") as HTMLElement | null;
  if (thumbEl) {
    const bg = thumbEl.style.backgroundImage;
    const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    if (match) {
      pledgeImage = match[1].startsWith("http")
        ? match[1]
        : `https://robertsspaceindustries.com${match[1]}`;
    }
  }

  const items: RsiPledgeItem[] = [];

  li.querySelectorAll(".with-images .item").forEach((itemEl) => {
    items.push(parseItem(itemEl as HTMLElement));
  });

  li.querySelectorAll(".without-images .item").forEach((itemEl) => {
    const titleEl = itemEl.querySelector(".title");
    const text = titleEl?.textContent?.trim() ?? "";
    if (text && !items.find((i) => i.title === text)) {
      items.push({ title: text, kind: null });
    }
  });

  // Extract insurance type from items
  const insuranceItem = items.find((i) => i.kind === "Insurance");
  let insuranceType: string | null = null;
  if (insuranceItem) {
    const t = insuranceItem.title;
    if (t.includes("Lifetime") || t.includes("LTI")) {
      insuranceType = "LTI";
    } else {
      // Extract duration: "6-Month Insurance" → "6-Month", "120-Month Insurance" → "120-Month"
      const durMatch = t.match(/(\d+[\s-]?(?:Month|Year))/i);
      insuranceType = durMatch ? durMatch[1].replace(/\s+/g, "-") : t.replace(/\s*Insurance\s*/i, "").trim() || null;
    }
  }

  const hasLti = insuranceType === "LTI";
  const isWarbond = /warbond/i.test(name);
  const nameUpper = name.toUpperCase();
  const isReward =
    nameUpper.includes("REWARD") || nameUpper.includes("REFERRAL") ||
    nameUpper.includes("PROMOTIONAL") || nameUpper.includes("SUBSCRIBER") ||
    nameUpper.includes("FLAIR");

  return {
    id, name, value, valueCents, configurationValue, currency, date,
    isUpgraded, isGiftable, isReclaimable, hasUpgradeLog,
    hasLti, isWarbond, isReward, availability, insuranceType,
    items, nameableShips, nameReservations, upgradeData, pledgeImage,
  };
}

function parseItem(itemEl: HTMLElement): RsiPledgeItem {
  const titleEl = itemEl.querySelector(".title");
  const kindEl = itemEl.querySelector(".kind");
  const imgEl = itemEl.querySelector(".image") as HTMLElement | null;
  const customNameEl = itemEl.querySelector(".custom-name-text");

  const item: RsiPledgeItem = {
    title: titleEl?.textContent?.trim() ?? "",
    kind: kindEl?.textContent?.trim() ?? null,
  };

  const liners = itemEl.querySelectorAll(".liner");
  for (const liner of liners) {
    const text = liner.textContent?.trim() ?? "";
    if (text.startsWith("Serial:")) {
      item.serial = text.replace("Serial:", "").trim();
    } else if (!item.manufacturer) {
      const codeSpan = liner.querySelector("span");
      if (codeSpan) {
        item.manufacturerCode = codeSpan.textContent?.trim() ?? "";
        item.manufacturer = text.replace(`(${item.manufacturerCode})`, "").trim();
      } else {
        item.manufacturer = text;
      }
    }
  }

  if (imgEl) {
    const bg = imgEl.style.backgroundImage;
    const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    if (match) item.image = match[1];
  }

  if (customNameEl) {
    item.customName = customNameEl.textContent?.trim() ?? "";
  }

  if (itemEl.classList.contains("contains-nameable")) {
    item.isNameable = true;
  }

  return item;
}

// ── All-Pages Loading ──

async function loadAllPages() {
  loading = true;
  stopped = false;
  abortController = new AbortController();
  updateLoadingState(true, "Loading all pledges...");

  const locale = getLocale();
  const t0 = performance.now();

  // Track which IDs we already have from page 1
  const existingIds = new Set(inventory.map((e) => e.data.id));

  try {
    const probePages = Array.from({ length: PROBE_BATCH }, (_, i) => i + 1);
    updateLoadingState(true, `Loading pages 1-${PROBE_BATCH}...`);

    const probeResults = await concurrentMap(
      probePages,
      (p) => fetchPageNodes(locale, p),
      { concurrency: 5, signal: abortController.signal },
    );

    let lastFullPage = 0;
    for (let i = 0; i < probeResults.length; i++) {
      const entries = probeResults[i];
      if (entries.length === 0) break;
      for (const entry of entries) {
        if (!existingIds.has(entry.data.id)) {
          existingIds.add(entry.data.id);
          inventory.push(entry);
        }
      }
      if (entries.length === 10) lastFullPage = i + 1;
    }

    if (lastFullPage === PROBE_BATCH) {
      const remaining = Array.from(
        { length: MAX_PAGES - PROBE_BATCH },
        (_, i) => PROBE_BATCH + 1 + i,
      );
      updateLoadingState(true, `Loading remaining pages...`);

      const remainResults = await concurrentMap(
        remaining,
        (p) => fetchPageNodes(locale, p),
        { concurrency: 5, shouldStop: (entries) => entries.length === 0, signal: abortController.signal },
      );

      for (const entries of remainResults) {
        if (entries.length === 0) break;
        for (const entry of entries) {
          if (!existingIds.has(entry.data.id)) {
            existingIds.add(entry.data.id);
            inventory.push(entry);
          }
        }
      }
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[SC Bridge] Loaded ${inventory.length} pledges in ${elapsed}s`);

    // F10: Save to cache
    saveToCache();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.log("[SC Bridge] Page loading was aborted");
    } else {
      console.error("[SC Bridge] Failed to load all pages:", err);
      // P8: Restore pagers on failure
      restorePager();
    }
  }

  loading = false;
  // P1: Resolve the loading promise
  if (loadingResolver) {
    loadingResolver();
    loadingResolver = null;
  }

  updateLoadingState(false);
  hidePager();

  // P6: Rebuild filter count cache
  rebuildFilterCountCache();

  // F9: Build fuse index
  rebuildFuseIndex();

  applyFilters();

  // Billing-based payment detection — runs in background after pledges are loaded.
  // Fetches billing pages to determine cash vs store credit per pledge.
  // Results are extension-local only (never sent to SC Bridge API).
  buildPledgePaymentMap((d) => console.log(`[SC Bridge] Payment: ${d}`))
    .then(() => {
      if (paymentMethodMap.size > 0) {
        applyPaymentBadges();
      }
    })
    .catch((err) => console.warn("[SC Bridge] Payment map failed:", err));
}

/** P6: Compute total counts for each filter once when inventory changes */
function rebuildFilterCountCache() {
  filterCountCache.clear();
  for (const f of FILTERS) {
    let count = 0;
    for (const e of inventory) {
      if (matchesFilter(e.data, f.key)) count++;
    }
    filterCountCache.set(f.key, count);
  }
}

/** F9: Rebuild Fuse.js index */
function rebuildFuseIndex() {
  fuseIndex = new Fuse(inventory, {
    keys: [
      { name: "data.name", weight: 2 },
      { name: "data.items.title", weight: 1.5 },
      { name: "data.items.manufacturer", weight: 1 },
      { name: "data.items.customName", weight: 1.5 },
    ],
    threshold: 0.4,
    includeScore: true,
  });
}

/** P10: Fetch a page's HTML with timeout, parse <li> nodes, and adopt into live document */
async function fetchPageNodes(locale: string, page: number): Promise<PledgeEntry[]> {
  const url = `${window.location.origin}/${locale}/account/pledges?page=${page}`;
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[SC Bridge] Pledge page ${page} returned ${response.status}`);
      return [];
    }
    const html = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = doc.querySelectorAll(".list-items > li");

    if (rows.length === 0 || doc.querySelector(".empy-list, .empty-list")) return [];

    const entries: PledgeEntry[] = [];
    for (const li of rows) {
      // Adopt the node into the live document so it can be appended later
      const adopted = document.adoptNode(li) as HTMLLIElement;
      const entry = collectNode(adopted);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn(`[SC Bridge] Pledge page ${page} fetch timed out`);
    } else if (err instanceof DOMException && err.name === "TimeoutError") {
      console.warn(`[SC Bridge] Pledge page ${page} fetch timed out`);
    } else {
      console.warn(`[SC Bridge] Pledge page ${page} fetch failed:`, err);
    }
    return [];
  }
}

// ── Toolbar ──

function injectToolbar() {
  const toolbar = document.createElement("div");
  toolbar.id = "scb-toolbar";

  // Build filter buttons HTML
  const contentFilters = FILTERS.filter((f) => f.group === "content");
  const statusFilters = FILTERS.filter((f) => f.group === "status");

  toolbar.innerHTML = `
    <div class="scb-hud-corner scb-hud-tl"></div>
    <div class="scb-hud-corner scb-hud-br"></div>
    <div class="scb-toolbar-section">
      <div class="scb-toolbar-row">
        <div class="scb-filters">
          <button class="scb-filter-btn scb-filter-all active" data-filter="all">All</button>
          ${contentFilters.map(
            (f) => `<button class="scb-filter-btn" data-filter="${f.key}">${f.label}</button>`,
          ).join("")}
          <span class="scb-filter-sep"></span>
          ${statusFilters.map(
            (f) => `<button class="scb-filter-btn" data-filter="${f.key}">${f.label}</button>`,
          ).join("")}
        </div>
      </div>
      <div class="scb-filter-hint">Click = solo filter &middot; Shift+click = combine &middot; Ctrl+click = exclude</div>
    </div>
    <div class="scb-glow-sep"></div>
    <div class="scb-toolbar-section">
      <div class="scb-toolbar-row scb-search-sort-row">
        <div class="scb-search-wrap">
          <svg class="scb-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="scb-search" placeholder="Search pledges..." />
        </div>
        <select class="scb-sort-select" id="scb-sort">
          ${SORT_OPTIONS.map((o) => `<option value="${o.key}"${o.key === sortKey ? " selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="scb-glow-sep"></div>
    <div class="scb-toolbar-section">
      <div class="scb-stats-row">
        <div class="scb-stat-block">
          <span class="scb-stat-label">Total Pledge Value</span>
          <span class="scb-stat-value" id="scb-total">loading...</span>
        </div>
        <div class="scb-stat-block">
          <span class="scb-stat-label">Pledges</span>
          <span class="scb-stat-count" id="scb-count">...</span>
        </div>
      </div>
    </div>
    <div class="scb-glow-sep"></div>
    <div class="scb-toolbar-section">
      <div class="scb-toolbar-row scb-actions-row">
        <div class="scb-page-controls" id="scb-page-controls">
          <select class="scb-page-size-select" id="scb-page-size">
            ${PAGE_SIZE_OPTIONS.map((s) => `<option value="${s}"${s === pageSize ? " selected" : ""}>${s === 0 ? "All" : s}</option>`).join("")}
          </select>
          <span class="scb-page-size-label">per page</span>
          <div class="scb-pager-nav" id="scb-pager-nav"></div>
        </div>
        <div class="scb-actions">
          <button class="scb-action-btn" id="scb-refresh-btn" title="Refresh data (bypass cache)">Refresh</button>
          <button class="scb-action-btn" id="scb-export-btn">Export</button>
          <button class="scb-action-btn scb-sync-btn" id="scb-sync" title="Sync to SC Bridge">
            Sync to SC Bridge
          </button>
        </div>
      </div>
    </div>
    <div id="scb-loading" class="scb-loading">
      <div class="scb-shimmer"></div>
      <span class="scb-loading-text">Loading all pledges...</span>
    </div>
  `;

  nativeList!.parentElement?.insertBefore(toolbar, nativeList);

  // "All" button
  toolbar.querySelector<HTMLButtonElement>(".scb-filter-all")?.addEventListener("click", () => {
    includeFilters.clear();
    excludeFilters.clear();
    updateFilterButtonStates(toolbar);
    applyFilters();
  });

  // Filter buttons
  toolbar.querySelectorAll<HTMLButtonElement>(".scb-filter-btn:not(.scb-filter-all)").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const key = btn.dataset.filter as FilterKey;

      if (e.ctrlKey || e.metaKey) {
        includeFilters.delete(key);
        if (excludeFilters.has(key)) { excludeFilters.delete(key); }
        else { excludeFilters.add(key); }
      } else if (e.shiftKey) {
        excludeFilters.delete(key);
        if (includeFilters.has(key)) { includeFilters.delete(key); }
        else { includeFilters.add(key); }
      } else {
        if (includeFilters.size === 1 && includeFilters.has(key) && excludeFilters.size === 0) {
          includeFilters.clear();
        } else {
          includeFilters.clear();
          excludeFilters.clear();
          includeFilters.add(key);
        }
      }

      updateFilterButtonStates(toolbar);
      applyFilters();
    });
  });

  // P4: Search with debounce
  const searchInput = toolbar.querySelector<HTMLInputElement>(".scb-search");
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase().trim();
    // Debounce the filter application
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  });

  // F3: Sort dropdown
  const sortSelect = toolbar.querySelector<HTMLSelectElement>("#scb-sort");
  sortSelect?.addEventListener("change", () => {
    sortKey = sortSelect.value as SortKey;
    storePreference("scb_sort_key", sortKey);
    applyFilters();
  });

  // F4: Page size selector
  const pageSizeSelect = toolbar.querySelector<HTMLSelectElement>("#scb-page-size");
  pageSizeSelect?.addEventListener("change", () => {
    pageSize = parseInt(pageSizeSelect.value);
    currentPage = 1;
    storePreference("scb_page_size", pageSize);
    render();
    updatePagerNav();
  });

  // F10: Refresh button (cache bypass)
  document.getElementById("scb-refresh-btn")?.addEventListener("click", () => {
    cacheBypass = true;
    // Reset state
    inventory = [];
    filtered = [];
    filterCountCache.clear();
    fuseIndex = null;
    selectedIds.clear();
    currentPage = 1;
    loading = true;
    loadingPromise = new Promise((r) => { loadingResolver = r; });

    // Re-collect page 1 nodes
    if (nativeList) collectNodesFromContainer(nativeList);
    loadAllPages();
  });

  // Export
  document.getElementById("scb-export-btn")?.addEventListener("click", showExportModal);

  // Sync
  document.getElementById("scb-sync")?.addEventListener("click", triggerSync);
}

// ── Filtering ──

function updateFilterButtonStates(toolbar: HTMLElement) {
  const noFilters = includeFilters.size === 0 && excludeFilters.size === 0;
  toolbar.querySelector<HTMLButtonElement>(".scb-filter-all")
    ?.classList.toggle("active", noFilters);
  toolbar.querySelectorAll<HTMLButtonElement>(".scb-filter-btn:not(.scb-filter-all)").forEach((b) => {
    const key = b.dataset.filter as FilterKey;
    b.classList.remove("active");
    b.classList.remove("excluded");
    if (includeFilters.has(key)) b.classList.add("active");
    if (excludeFilters.has(key)) b.classList.add("excluded");
  });
}

function matchesFilter(pledge: RsiPledge, filter: FilterKey): boolean {
  switch (filter) {
    case "ships": return pledge.items.some((i) => i.kind === "Ship" || i.kind === "Vehicle");
    case "ccus": return /^upgrade\s*-/i.test(pledge.name) || !!pledge.upgradeData;
    case "freeCcus":
      return (/^upgrade\s*-/i.test(pledge.name) || !!pledge.upgradeData) && pledge.valueCents === 0;
    case "packages":
      return pledge.items.some((i) =>
        i.title.includes("Star Citizen Digital Download") ||
        i.title.includes("Squadron 42 Digital Download"));
    case "combos": {
      const shipCount = pledge.items.filter((i) => i.kind === "Ship" || i.kind === "Vehicle").length;
      return shipCount >= 2;
    }
    case "flair": return pledge.isReward || pledge.items.some((i) => i.kind === "Hangar decoration");
    case "weapons": return pledge.items.some((i) =>
      i.kind === "Weapon" || i.kind === "FPS Weapon" ||
      (i.kind === "FPS Equipment" && /weapon|gun|rifle|pistol|shotgun|smg|lmg|sniper|launcher/i.test(i.title)));
    case "armour": return pledge.items.some((i) =>
      (i.kind === "FPS Equipment" || i.kind === null) &&
      /armou?r|helmet|undersuit|chest|legs|arms|core/i.test(i.title));
    case "lti": return pledge.hasLti;
    case "warbond": return pledge.isWarbond;
    case "giftable": return pledge.isGiftable;
    case "meltable": return pledge.isReclaimable;
    case "upgraded": return pledge.isUpgraded;
    case "valuable": return pledge.valueCents >= VALUABLE_THRESHOLD * 100;
    case "reward": return pledge.isReward;
  }
}

/** F3: Sort inventory by current sort key */
function sortInventory(entries: PledgeEntry[]): PledgeEntry[] {
  const sorted = [...entries];
  switch (sortKey) {
    case "newest":
      sorted.sort((a, b) => b.data.id - a.data.id);
      break;
    case "oldest":
      sorted.sort((a, b) => a.data.id - b.data.id);
      break;
    case "name-az":
      sorted.sort((a, b) => cleanPledgeName(a.data.name).localeCompare(cleanPledgeName(b.data.name)));
      break;
    case "name-za":
      sorted.sort((a, b) => cleanPledgeName(b.data.name).localeCompare(cleanPledgeName(a.data.name)));
      break;
    case "value-high":
      sorted.sort((a, b) => b.data.valueCents - a.data.valueCents);
      break;
    case "value-low":
      sorted.sort((a, b) => a.data.valueCents - b.data.valueCents);
      break;
  }
  return sorted;
}

function applyFilters() {
  // F9: Use fuzzy search for 3+ char queries
  let searchResults: PledgeEntry[] | null = null;
  if (searchQuery && searchQuery.length >= 3 && fuseIndex) {
    const fuseResults = fuseIndex.search(searchQuery);
    searchResults = fuseResults.map((r) => r.item);
  }

  const baseSet = searchResults ?? inventory;

  filtered = baseSet.filter(({ data }) => {
    for (const filter of includeFilters) {
      if (!matchesFilter(data, filter)) return false;
    }
    for (const filter of excludeFilters) {
      if (matchesFilter(data, filter)) return false;
    }
    // For 1-2 char queries, use substring match (non-fuzzy)
    if (searchQuery && (!searchResults || searchQuery.length < 3)) {
      const text = `${data.name} ${data.items.map((i) => i.title).join(" ")}`.toLowerCase();
      if (!text.includes(searchQuery)) return false;
    }
    return true;
  });

  // F3: Sort
  filtered = sortInventory(filtered);

  // Reset to page 1 when filters change
  currentPage = 1;

  updateStats();
  render();
  updatePagerNav();
  updateSelectionUI();
}

/**
 * P5: Empty the native .list-items and append the filtered nodes via DocumentFragment.
 * The DOM nodes are never destroyed — RSI's event listeners survive.
 * F4: Apply pagination.
 */
function render() {
  if (!nativeList) return;

  // F4: Pagination — slice filtered array
  let toRender = filtered;
  if (pageSize > 0) {
    const start = (currentPage - 1) * pageSize;
    toRender = filtered.slice(start, start + pageSize);
  }

  // P5: Use DocumentFragment to batch all appends
  const fragment = document.createDocumentFragment();
  for (const { node } of toRender) {
    fragment.appendChild(node);
  }

  // Detach all children (moves nodes out, doesn't destroy them)
  while (nativeList.firstChild) {
    nativeList.removeChild(nativeList.firstChild);
  }

  // Single append of the fragment
  nativeList.appendChild(fragment);
}

/** F4: Update pagination controls */
function updatePagerNav() {
  const nav = document.getElementById("scb-pager-nav");
  if (!nav) return;

  if (pageSize === 0 || filtered.length <= pageSize) {
    nav.innerHTML = "";
    return;
  }

  const totalPages = Math.ceil(filtered.length / pageSize);
  const buttons: string[] = [];

  // Previous
  buttons.push(`<button class="scb-page-btn" data-page="prev" ${currentPage <= 1 ? "disabled" : ""}>&laquo;</button>`);

  // Page numbers (show max 7 pages with ellipsis)
  const maxVisible = 7;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  if (startPage > 1) {
    buttons.push(`<button class="scb-page-btn" data-page="1">1</button>`);
    if (startPage > 2) buttons.push(`<span class="scb-page-ellipsis">...</span>`);
  }

  for (let i = startPage; i <= endPage; i++) {
    buttons.push(`<button class="scb-page-btn${i === currentPage ? " active" : ""}" data-page="${i}">${i}</button>`);
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) buttons.push(`<span class="scb-page-ellipsis">...</span>`);
    buttons.push(`<button class="scb-page-btn" data-page="${totalPages}">${totalPages}</button>`);
  }

  // Next
  buttons.push(`<button class="scb-page-btn" data-page="next" ${currentPage >= totalPages ? "disabled" : ""}>&raquo;</button>`);

  nav.innerHTML = buttons.join("");

  // Attach click handlers
  nav.querySelectorAll<HTMLButtonElement>(".scb-page-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page!;
      if (page === "prev") currentPage = Math.max(1, currentPage - 1);
      else if (page === "next") currentPage = Math.min(totalPages, currentPage + 1);
      else currentPage = parseInt(page);
      render();
      updatePagerNav();
      // Scroll to top of list
      nativeList?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// ── Stats ──

function updateLoadingState(isLoading: boolean, message?: string) {
  const el = document.getElementById("scb-loading");
  if (el) {
    el.style.display = isLoading ? "flex" : "none";
    const textEl = el.querySelector(".scb-loading-text");
    if (textEl && message) textEl.textContent = message;
  }
}

function updateStats() {
  const totalEl = document.getElementById("scb-total");
  const countEl = document.getElementById("scb-count");
  if (!totalEl || !countEl) return;

  const totalAll = inventory.reduce((sum, e) => sum + e.data.valueCents, 0);
  const totalFiltered = filtered.reduce((sum, e) => sum + e.data.valueCents, 0);

  totalEl.textContent = formatCurrency(totalAll / 100);

  if (filtered.length < inventory.length) {
    countEl.textContent = `${filtered.length} of ${inventory.length} — ${formatCurrency(totalFiltered / 100)}`;
  } else {
    countEl.textContent = `${inventory.length}`;
  }

  // P6: Filter button counts — use cached totals for all-inventory counts
  const allBtnEl = document.querySelector<HTMLButtonElement>(".scb-filter-all");
  if (allBtnEl) allBtnEl.textContent = `All (${inventory.length})`;

  const hasActiveFilters = includeFilters.size > 0 || excludeFilters.size > 0;
  document.querySelectorAll<HTMLButtonElement>(".scb-filter-btn:not(.scb-filter-all)").forEach((btn) => {
    const key = btn.dataset.filter as FilterKey;
    const total = filterCountCache.get(key) ?? 0;
    const label = FILTERS.find((f) => f.key === key)?.label ?? key;

    if (hasActiveFilters) {
      // Only recompute filtered counts (not total counts)
      let current = 0;
      for (const e of filtered) {
        if (matchesFilter(e.data, key)) current++;
      }
      btn.textContent = `${label} (${current}/${total})`;
    } else {
      btn.textContent = `${label} (${total})`;
    }
  });
}

function formatCurrency(amount: number): string {
  if (privacyMode === "hidden") return "$\u2022\u2022\u2022";
  const display = privacyMode === "stealth"
    ? Math.round(amount * stealthPercent / 100)
    : amount;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(display);
}

// ── RSI Fetch Helpers (content-script-safe) ──

/** Get RSI token via the background script (can read HttpOnly cookies) */
async function getRsiToken(): Promise<string | null> {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_RSI_TOKEN" });
    return response?.token ?? null;
  } catch {
    // Fallback: try document.cookie (works if not HttpOnly)
    const match = document.cookie.match(/Rsi-Token=([^;]+)/);
    return match ? match[1] : null;
  }
}

async function rsiPostFromContent<T>(path: string, body: Record<string, unknown> = {}): Promise<T | null> {
  const token = await getRsiToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Rsi-Token": token } : {}),
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.warn(`[SC Bridge] RSI POST ${path} returned ${response.status}`);
    return null;
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`[SC Bridge] RSI POST ${path} returned non-JSON`);
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** P12: Run async tasks with bounded concurrency + serialized rate-limited dispatch + abort support. */
async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  {
    concurrency = 5,
    delayMs = RSI_REQUEST_DELAY_MS,
    shouldStop,
    signal,
  }: {
    concurrency?: number;
    delayMs?: number;
    shouldStop?: (result: R, index: number) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  let localStopped = false;

  // Serial dispatch queue — only one worker acquires the next item at a time,
  // enforcing the rate limit without races between concurrent workers.
  let dispatchReady = Promise.resolve();

  async function acquireSlot(): Promise<number | null> {
    return new Promise((resolve) => {
      dispatchReady = dispatchReady.then(async () => {
        if (localStopped || stopped || idx >= items.length || signal?.aborted) {
          resolve(null);
          return;
        }
        const i = idx++;
        if (i > 0) await delay(delayMs);
        resolve(i);
      });
    });
  }

  async function worker() {
    while (!localStopped && !stopped && !signal?.aborted) {
      const i = await acquireSlot();
      if (i === null) break;
      results[i] = await fn(items[i]);
      if (shouldStop?.(results[i], i)) {
        localStopped = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Background-Triggered Collection (Bridge Sync Flow) ──

async function handleCollectAll(): Promise<SyncPayload> {
  // P1: Wait for loading to complete via Promise instead of spin-wait
  const deadline = Date.now() + COLLECT_TIMEOUT_MS;

  if (loading) {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for hangar data to load")), Math.max(0, deadline - Date.now()));
    });
    await Promise.race([loadingPromise, timeoutPromise]);
  }

  const noop = () => {};

  const [account, buybacks, upgrades] = await Promise.all([
    collectAccountInfo(noop),
    collectBuyBackPledges(noop),
    collectUpgradeLogs(inventory.map((e) => e.data), noop),
  ]);

  const pledges = inventory.map((e) => e.data);
  const named_ships = collectNamedShips(pledges);

  return {
    pledges,
    buyback_pledges: buybacks,
    upgrades,
    account,
    named_ships,
    sync_meta: {
      extension_version: browser.runtime.getManifest().version,
      synced_at: new Date().toISOString(),
      pledge_count: inventory.length,
      buyback_count: buybacks.length,
      ship_count: inventory.filter((e) =>
        e.data.items.some((i) => i.kind === "Ship"),
      ).length,
      item_count: inventory.reduce((n, e) => n + e.data.items.length, 0),
    },
  };
}

// ── Data Collection Functions ──

interface CollectionProgress {
  category: string;
  status: "pending" | "collecting" | "done" | "error";
  detail?: string;
}

type ProgressCallback = (updates: CollectionProgress[]) => void;

interface CollectedData {
  pledges: RsiPledge[];
  buybackPledges: RsiBuyBackPledge[];
  upgrades: RsiUpgrade[];
  account: RsiAccountInfo | null;
  namedShips: NamedShip[];
}

async function collectAccountInfo(onProgress: (detail: string) => void): Promise<RsiAccountInfo | null> {
  onProgress("Dashboard...");
  try {
    // ── 1. Dashboard props — profile, concierge, subscriber, credits, featured badges ──
    const locale = getLocale();
    const response = await fetch(`${window.location.origin}/${locale}/account/dashboard`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const propsEl = doc.querySelector("[data-platform-client-props]");
    if (!propsEl) {
      onProgress("No account data found");
      return null;
    }

    const propsJson = propsEl.getAttribute("data-platform-client-props");
    if (!propsJson) return null;

    const props = JSON.parse(propsJson);
    const acct = props.routerParams?.account ?? {};
    const user = props.user ?? {};

    const info: RsiAccountInfo = {
      nickname: acct.nickname ?? user.nickname ?? "",
      displayname: acct.displayname ?? user.displayname ?? "",
    };

    // Avatar — make absolute
    if (acct.avatar) {
      info.avatar_url = acct.avatar.startsWith("http")
        ? acct.avatar
        : `https://robertsspaceindustries.com${acct.avatar}`;
    }
    if (acct.enlistedSince) info.enlisted_since = acct.enlistedSince;
    if (acct.countryName) info.country = acct.countryName;
    if (user.referral?.referralCode) info.referral_code = user.referral.referralCode;
    info.has_game_package = user.hasGamePackage ?? undefined;
    info.is_subscriber = user.isSubscriber ?? undefined;

    // Concierge
    const concierge = acct.conciergeData;
    if (concierge) {
      info.concierge_level = concierge.conciergeCurrentLevel ?? concierge.level;
      info.concierge_next_level = concierge.conciergeNextLevel ?? concierge.next_level;
      info.concierge_progress = concierge.conciergeNextLevelPercentage ?? concierge.progress;
    }

    // Subscriber
    const subscriber = acct.subscriberData;
    if (subscriber) {
      info.subscriber_type = subscriber.type;
      info.subscriber_frequency = subscriber.frequency;
    }

    // Credits — array of {currency, variant, label, symbol, value}
    const creditsArr = acct.creditsData;
    if (Array.isArray(creditsArr)) {
      for (const c of creditsArr) {
        if (c.variant === "store" && c.value != null) {
          info.store_credit_cents = Math.round(Number(c.value) * 100);
        } else if (c.variant === "uec" && c.value != null) {
          info.uec_balance = Number(c.value);
        } else if (c.variant === "rec" && c.value != null) {
          info.rec_balance = Number(c.value);
        }
      }
    }

    // Featured badges from dashboard
    const featuredBadges = acct.featuredBadges;
    if (Array.isArray(featuredBadges) && featuredBadges.length > 0) {
      info.featured_badges = featuredBadges.map((b: Record<string, unknown>): RsiBadgeDisplay => {
        const img = b.image as Record<string, string> | undefined;
        return {
          title: img?.title ?? img?.alt ?? "",
          image_url: img?.src?.startsWith("http")
            ? img.src
            : `https://robertsspaceindustries.com${img?.src ?? ""}`,
          org_url: (b.href as string) ?? undefined,
        };
      });
    }

    // Primary org from user object
    if (user.org?.name) {
      const orgUrl = user.org.url ?? "";
      const sid = orgUrl.replace(/^\/orgs\//i, "") || user.org.sid || "";
      info.org = {
        name: user.org.name,
        sid,
        image: user.org.img?.startsWith("http")
          ? user.org.img
          : user.org.img ? `https://robertsspaceindustries.com${user.org.img}` : undefined,
        url: orgUrl,
        is_primary: true,
      };
    }

    // ── 2. All badges via API ──
    onProgress("Badges...");
    await delay(RSI_REQUEST_DELAY_MS);
    try {
      const badgeResult = await rsiPostFromContent<{
        success?: number;
        data?: { badges: Record<string, string> };
      }>(RSI_API.badges);

      if (badgeResult) {
        // RSI wraps as {success:1, code:"OK", data:{badges:{...}}}
        const badgesMap = badgeResult.data?.badges;
        if (badgesMap && typeof badgesMap === "object") {
          info.all_badges = badgesMap;
        }
      }
    } catch (err) {
      console.error("[SC Bridge] Failed to fetch badges:", err);
    }

    // ── 3. All orgs — scrape /en/account/organization page ──
    // No working API exists for user org memberships; data is server-rendered HTML.
    onProgress("Orgs...");
    await delay(RSI_REQUEST_DELAY_MS);
    try {
      const orgResponse = await fetch(`${window.location.origin}/${locale}/account/organization`, {
        credentials: "same-origin",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const orgHtml = await orgResponse.text();
      const orgDoc = new DOMParser().parseFromString(orgHtml, "text/html");

      // Each org is a .js-org card with data-org-name, data-org-sid, data-member-id
      const orgCards = orgDoc.querySelectorAll(".js-org");
      if (orgCards.length > 0) {
        info.orgs = Array.from(orgCards).map((card): RsiOrgInfo => {
          const sid = card.getAttribute("data-org-sid") ?? "";
          const name = card.getAttribute("data-org-name") ?? "";
          const isMain = card.classList.contains("org-main");

          // Rank from "Organization rank" label's sibling <strong>
          const entries = card.querySelectorAll(".entry");
          let rank: string | undefined;
          for (const entry of entries) {
            const label = entry.querySelector(".label");
            if (label?.textContent?.includes("Organization rank")) {
              rank = entry.querySelector(".value")?.textContent?.trim();
            }
          }

          // Image from the thumb <img>
          const imgEl = card.querySelector(".thumb img") as HTMLImageElement | null;
          const imgSrc = imgEl?.getAttribute("src") ?? "";
          const image = imgSrc
            ? (imgSrc.startsWith("http") ? imgSrc : `https://robertsspaceindustries.com${imgSrc}`)
            : undefined;

          // Member count
          const membersEl = card.querySelector(".members");
          const membersText = membersEl?.textContent?.trim();

          return { name, sid, image, url: `/orgs/${sid}`, rank, is_primary: isMain, members: membersText };
        });
      }
    } catch (err) {
      console.error("[SC Bridge] Failed to fetch org info:", err);
    }

    onProgress("Done");
    return info;
  } catch (err) {
    console.error("[SC Bridge] Failed to collect account info:", err);
    onProgress("Failed");
    return null;
  }
}

/** P2: Parallelize upgrade log fetching with concurrentMap */
async function collectUpgradeLogs(
  pledges: RsiPledge[],
  onProgress: (detail: string) => void,
): Promise<RsiUpgrade[]> {
  const upgradeable = pledges.filter((p) => p.hasUpgradeLog);
  if (upgradeable.length === 0) {
    onProgress("No upgrade logs");
    return [];
  }

  const allUpgrades: RsiUpgrade[][] = [];
  let completed = 0;

  const results = await concurrentMap(
    upgradeable,
    async (pledge) => {
      const upgrades: RsiUpgrade[] = [];
      try {
        const result = await rsiPostFromContent<{
          success: number;
          data: { rendered: string };
        }>(RSI_API.upgradeLog, { pledge_id: pledge.id });

        if (result?.success === 1 && result.data?.rendered) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(result.data.rendered, "text/html");

          // Parse upgrade log rows — each row has date, upgrade name, new value
          const rows = doc.querySelectorAll(".row, tr, li");
          for (const row of rows) {
            const labels = row.querySelectorAll("label, td, span");
            const texts: string[] = [];
            labels.forEach((l) => {
              const t = l.textContent?.trim();
              if (t) texts.push(t);
            });

            // Try to extract: date, name, value from the row
            if (texts.length >= 2) {
              const dateMatch = texts[0].match(/\w+\s+\d{1,2},?\s+\d{4}/);
              upgrades.push({
                pledge_id: pledge.id,
                name: texts.length >= 3 ? texts[1] : texts[0],
                applied_at: dateMatch ? dateMatch[0] : texts[0],
                new_value: texts[texts.length - 1],
              });
            }
          }
        }
      } catch (err) {
        console.error(`[SC Bridge] Failed to get upgrade log for pledge ${pledge.id}:`, err);
      }

      completed++;
      onProgress(`${completed}/${upgradeable.length}`);
      return upgrades;
    },
    { concurrency: 3 },
  );

  onProgress("Done");
  return results.flat();
}

/** P3: Parallelize buyback page fetching with probe-then-continue pattern */
async function collectBuyBackPledges(
  onProgress: (detail: string) => void,
): Promise<RsiBuyBackPledge[]> {
  const buybacks: RsiBuyBackPledge[] = [];
  const locale = getLocale();

  try {
    // Fetch page 1 first
    onProgress("Page 1...");
    const page1 = await fetchBuybackPage(locale, 1);
    buybacks.push(...page1.pledges);

    if (page1.pledges.length === 0) {
      onProgress("None");
      return buybacks;
    }

    // If page 1 has results, probe pages 2-5 concurrently
    if (page1.hasMore) {
      let currentBatch = 2;
      let keepGoing = true;

      while (keepGoing && currentBatch <= BUYBACK_MAX_PAGES) {
        const endPage = Math.min(currentBatch + BUYBACK_PROBE_BATCH - 1, BUYBACK_MAX_PAGES);
        const pages = Array.from({ length: endPage - currentBatch + 1 }, (_, i) => currentBatch + i);
        onProgress(`Pages ${currentBatch}-${endPage}...`);

        const results = await concurrentMap(
          pages,
          (p) => fetchBuybackPage(locale, p),
          { concurrency: 3 },
        );

        for (const result of results) {
          if (result.pledges.length === 0) {
            keepGoing = false;
            break;
          }
          buybacks.push(...result.pledges);
          if (!result.hasMore) {
            keepGoing = false;
            break;
          }
        }

        currentBatch = endPage + 1;
      }
    }
  } catch (err) {
    console.error("[SC Bridge] Failed to collect buy-back pledges:", err);
    onProgress("Failed");
    return buybacks;
  }

  console.log(`[SC Bridge] Buyback collection complete: ${buybacks.length} total`);
  onProgress(buybacks.length > 0 ? `${buybacks.length} found` : "None");
  return buybacks;
}

async function fetchBuybackPage(locale: string, page: number): Promise<{ pledges: RsiBuyBackPledge[]; hasMore: boolean }> {
  const response = await fetch(
    `${window.location.origin}/${locale}/account/buy-back-pledges?page=${page}&pagesize=${BUYBACK_PAGE_SIZE}`,
    {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    console.warn(`[SC Bridge] Buyback page ${page} returned ${response.status}`);
    return { pledges: [], hasMore: false };
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const pledgeEls = doc.querySelectorAll("article.pledge");
  if (pledgeEls.length === 0) return { pledges: [], hasMore: false };

  const pledges: RsiBuyBackPledge[] = [];
  for (const el of pledgeEls) {
    // ID from buyback link: /pledge/buyback/85851565
    const buybackLink = el.querySelector('a[href*="/pledge/buyback/"]');
    const idMatch = buybackLink?.getAttribute("href")?.match(/\/pledge\/buyback\/(\d+)/);
    const id = idMatch ? Number(idMatch[1]) : 0;

    // Name from h1 (strip " - upgraded" span)
    const h1 = el.querySelector("h1");
    const upgradedSpan = h1?.querySelector(".upgraded");
    if (upgradedSpan) upgradedSpan.remove();
    const name = h1?.textContent?.trim() ?? "";

    // Parse dt/dd pairs
    const dts = el.querySelectorAll("dt");
    let date = "";
    for (const dt of dts) {
      const label = dt.textContent?.trim() ?? "";
      const dd = dt.nextElementSibling as HTMLElement | null;
      const val = dd?.textContent?.trim() ?? "";
      if (label === "Last Modified") date = val;
    }

    const items: RsiPledgeItem[] = [];
    const isCreditReclaimable = !!buybackLink;

    pledges.push({
      id,
      name,
      value: "$0.00",
      value_cents: 0,
      date,
      items,
      is_credit_reclaimable: isCreditReclaimable,
    });
  }

  // Check if there are more pages
  const pagerLinks = doc.querySelectorAll(".pager a, .js-pager a");
  let hasNext = false;
  for (const link of pagerLinks) {
    const href = link.getAttribute("href") ?? link.getAttribute("rel") ?? "";
    if (href.includes(`page=${page + 1}`)) {
      hasNext = true;
      break;
    }
  }
  if (!hasNext && pledgeEls.length >= BUYBACK_PAGE_SIZE) {
    hasNext = true;
  }

  return { pledges, hasMore: hasNext };
}

function collectNamedShips(pledges: RsiPledge[]): NamedShip[] {
  const map = new Map<number, NamedShip>();
  for (const p of pledges) {
    if (p.nameableShips) {
      for (const s of p.nameableShips) {
        map.set(s.membership_id, s);
      }
    }
  }
  return Array.from(map.values());
}

// ── Billing-Based Payment Method Detection ──
//
// WHY: RSI does not expose whether a pledge was purchased with cash (warbond)
// or store credit anywhere in the hangar DOM or any API. The pledge name
// sometimes contains "Warbond" but CIG is inconsistent — many warbond
// purchases have clean names with no indicator. After exhaustively probing
// every RSI API, GraphQL field, and DOM attribute, the billing page at
// /account/billing is the ONLY source that reveals payment method via the
// "Credits used" field on each order.
//
// HOW IT WORKS:
// 1. Fetch billing pages (HTML) filtered to Pledge Store orders
// 2. Extract ONLY: order ID, credits used amount, item names + totals
// 3. Fetch pledge log (maps pledge ID → order ID)
// 4. Cross-reference: credits_used == $0 → CASH, credits == total → CREDIT, else MIXED
//
// PRIVACY PROTECTION:
// The billing page contains sensitive PII: full name, billing address,
// payment processor (e.g. STRIPE-UK), payment dates, and subscription
// details. We DELIBERATELY use precise CSS selectors to extract ONLY the
// fields listed above. We never read .bill-to, .address, PAYMENT INFO
// tables, subscription wrappers, or any element outside our target selectors.
// Raw HTML is parsed into structured data immediately and never stored.
// Billing data is used extension-locally for badge rendering only — it is
// NEVER included in the sync payload sent to SC Bridge.

interface BillingOrder {
  orderId: string;
  creditsUsed: number;
  itemsTotal: number;
  items: string[];
}

/**
 * Fetch billing pages and extract ONLY: order ID, credits used, item names/totals.
 *
 * PRIVACY: The billing page contains PII (billing address, full name, payment
 * processor). This function uses precise CSS selectors to read ONLY the order ID,
 * credits used amount, and item summary table. It deliberately skips:
 * - .bill-to.address (physical address)
 * - PAYMENT INFO table (processor names, transaction dates)
 * - .subscriptions-wrapper (subscription IDs, dates, amounts)
 * - Any col containing personal amounts or dates at order level
 *
 * Raw HTML is never stored — it's parsed via DOMParser, specific fields are
 * extracted, and the parsed document is discarded.
 */
async function collectBillingData(
  onProgress: (detail: string) => void,
): Promise<Map<string, BillingOrder>> {
  const orders = new Map<string, BillingOrder>();
  const locale = getLocale();
  let page = 1;

  try {
    while (page <= BILLING_MAX_PAGES) {
      onProgress(`Page ${page}...`);

      const response = await fetch(
        `${window.location.origin}/${locale}/account/billing?page=${page}&pagesize=${BILLING_PAGE_SIZE}&storefront=2`,
        { credentials: "same-origin", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!response.ok) break;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const orderRows = doc.querySelectorAll("ul.orders-item > li");
      if (orderRows.length === 0) break;

      for (const li of orderRows) {
        // PRIVACY: Extract ONLY the order ID from .basic-infos columns.
        // We iterate cols looking for the one labelled "Order Id:" and skip
        // all others (which contain dates, amounts, status — not needed).
        let orderId = "";
        const cols = li.querySelectorAll(".basic-infos .col");
        for (const col of cols) {
          const text = col.textContent?.trim() ?? "";
          if (text.includes("Order Id:")) {
            orderId = text.replace(/Order\s*Id:\s*/i, "").trim();
            break;
          }
        }
        if (!orderId) continue;

        // PRIVACY: Extract ONLY the "Credits used" dollar amount from the
        // order summary's right-section. This section also contains "Items",
        // "Total before Tax", and "VAT" — we only read the "Credits used"
        // <strong> tag and its adjacent <span>. The left-section (which
        // contains the billing address) is never accessed.
        let creditsUsed = 0;
        const rightSection = li.querySelector(".payment-wrapper .right-section");
        if (rightSection) {
          const strongs = rightSection.querySelectorAll("strong");
          for (const strong of strongs) {
            if (strong.textContent?.includes("Credits used")) {
              const sibling = strong.nextElementSibling;
              const creditsText = sibling?.textContent?.trim() ?? "";
              const match = creditsText.match(/\$([\d,]+(?:\.\d{2})?)/);
              if (match) creditsUsed = Math.round(parseFloat(match[1].replace(/,/g, "")) * 100);
              break;
            }
          }
        }

        // PRIVACY: Extract item names and totals ONLY from the billing-summary
        // table. We read td[0] (item name) and td[4] (total price) — skipping
        // td[1] (unit price), td[2] (quantity), td[3] (discount). The PAYMENT
        // INFO table (which contains processor names like "STRIPE-UK" and
        // transaction timestamps) is a separate <table> that we never touch.
        const items: string[] = [];
        let itemsTotal = 0;
        const tableRows = li.querySelectorAll("table.billing-summary tr");
        for (const tr of tableRows) {
          const tds = tr.querySelectorAll("td");
          if (tds.length < 5) continue;
          const itemName = tds[0].textContent?.trim() ?? "";
          const totalText = tds[4].textContent?.trim() ?? "";
          if (itemName) items.push(itemName);
          const totalMatch = totalText.match(/\$([\d,]+(?:\.\d{2})?)/);
          if (totalMatch) itemsTotal += Math.round(parseFloat(totalMatch[1].replace(/,/g, "")) * 100);
        }

        // Store only the extracted fields — raw HTML is discarded when
        // the DOMParser document goes out of scope.
        orders.set(orderId, { orderId, creditsUsed, itemsTotal, items });
      }

      // Check for next page
      const pagerLinks = doc.querySelectorAll(".pager a");
      let hasNext = false;
      for (const link of pagerLinks) {
        const href = link.getAttribute("href") ?? "";
        if (href.includes(`page=${page + 1}`)) { hasNext = true; break; }
      }
      if (!hasNext && orderRows.length < BILLING_PAGE_SIZE) break;
      if (!hasNext) break;

      page++;
      await delay(RSI_REQUEST_DELAY_MS);
    }
  } catch (err) {
    console.warn("[SC Bridge] Billing collection error:", err);
  }

  onProgress(`${orders.size} orders`);
  console.log(`[SC Bridge] Collected ${orders.size} billing orders from ${page} pages`);
  return orders;
}

/**
 * Build pledge ID → payment method map by cross-referencing pledge log with billing data.
 * Pledge log entries have format: "PledgeName #PLEDGEID - ... order #ORDERID, value: ..."
 *
 * PRIVACY: The pledge log contains user handles (e.g. "Created by NZVengeance") — we
 * extract ONLY the pledge ID (integer) and order ID (alphanumeric) via regex.
 * The resulting map contains only: { pledgeId: number → 'cash' | 'credit' | 'mixed' }.
 * No PII is stored. This map is kept in extension memory only and is never synced.
 */
async function buildPledgePaymentMap(onProgress: (detail: string) => void): Promise<void> {
  onProgress("Billing data...");

  // Collect billing and pledge log in parallel
  const [billingOrders, pledgeLogResult] = await Promise.all([
    collectBillingData((d) => onProgress(`Billing: ${d}`)),
    rsiPostFromContent<{ success: number; data: { rendered: string } }>("/api/account/pledgeLog"),
  ]);

  if (!pledgeLogResult?.data?.rendered || billingOrders.size === 0) {
    onProgress("No data");
    return;
  }

  // Parse pledge log to extract pledge ID → order ID mappings
  const pledgeToOrder = new Map<number, string>();
  const logHtml = pledgeLogResult.data.rendered;
  // Match: #PLEDGEID followed by ... order #ORDERID
  const entryRegex = /#(\d+)\s[^]*?order\s+#([A-Z0-9]+)/gi;
  let match;
  while ((match = entryRegex.exec(logHtml)) !== null) {
    const pledgeId = parseInt(match[1], 10);
    const orderId = match[2];
    if (pledgeId && orderId) pledgeToOrder.set(pledgeId, orderId);
  }

  // Cross-reference: pledge → order → billing → payment method
  let cashCount = 0, creditCount = 0, mixedCount = 0;
  for (const [pledgeId, orderId] of pledgeToOrder) {
    const order = billingOrders.get(orderId);
    if (!order) continue;

    let method: "cash" | "credit" | "mixed";
    if (order.creditsUsed === 0) {
      method = "cash";
      cashCount++;
    } else if (order.itemsTotal > 0 && order.creditsUsed >= order.itemsTotal) {
      method = "credit";
      creditCount++;
    } else {
      method = "mixed";
      mixedCount++;
    }
    paymentMethodMap.set(pledgeId, method);
  }

  console.log(`[SC Bridge] Payment map: ${cashCount} cash, ${creditCount} credit, ${mixedCount} mixed (${pledgeToOrder.size} pledges matched)`);
  onProgress(`${paymentMethodMap.size} resolved`);
}

/**
 * Re-render payment badges on already-enhanced pledge nodes after billing data arrives.
 * Uses only the paymentMethodMap (pledge ID → enum) — no PII involved at this stage.
 */
function applyPaymentBadges() {
  for (const { data, node } of inventory) {
    const row = node.querySelector<HTMLElement>(".scb-id-badges-row");
    if (!row) continue;

    const pledgeId = data.id;
    const method = paymentMethodMap.get(pledgeId);
    if (!method) continue;

    // Remove any existing payment badge (warbond/storecredit/mixed from initial render or name fallback)
    row.querySelectorAll(".scb-badge-warbond, .scb-badge-storecredit, .scb-badge-mixed").forEach((el) => el.remove());

    // Find insertion point: after the last insurance badge, or after the pledge ID
    const lastInsurance = row.querySelector(".scb-badge-insurance, .scb-badge-lti");
    const insertAfter = lastInsurance ?? row.querySelector(".scb-pledge-id");

    const badge = document.createElement("span");
    if (method === "cash") {
      badge.className = "scb-badge scb-badge-warbond";
      badge.textContent = "WARBOND";
    } else if (method === "credit") {
      badge.className = "scb-badge scb-badge-storecredit";
      badge.textContent = "STORE CREDIT";
    } else {
      badge.className = "scb-badge scb-badge-mixed";
      badge.textContent = "MIXED";
    }

    if (insertAfter?.nextSibling) {
      row.insertBefore(badge, insertAfter.nextSibling);
    } else {
      // Insert after pledge ID (before giftable/ccu badges)
      const giftable = row.querySelector(".scb-badge-giftable");
      if (giftable) {
        row.insertBefore(badge, giftable);
      } else {
        const ccu = row.querySelector(".scb-badge-ccu");
        if (ccu) row.insertBefore(badge, ccu);
        else row.appendChild(badge);
      }
    }
  }
}

// ── Export ──

function showExportModal() {
  document.getElementById("scb-export-modal")?.remove();

  const isFiltered = filtered.length < inventory.length;
  const count = filtered.length;

  const categoryHtml = Object.entries(SYNC_CATEGORIES)
    .filter(([key]) => key !== "spectrumFriends")
    .map(([key, cat]) => `
    <label class="scb-export-toggle">
      <input type="checkbox" data-cat="${key}" checked />
      <span class="scb-export-toggle-info">
        <span class="scb-export-toggle-label">${cat.label}</span>
        <span class="scb-export-toggle-desc">${cat.description}</span>
      </span>
    </label>
  `).join("");

  const overlay = document.createElement("div");
  overlay.id = "scb-export-modal";
  overlay.className = "scb-export-modal";
  overlay.innerHTML = `
    <div class="scb-popup-backdrop"></div>
    <div class="scb-export-panel">
      <div class="scb-export-header">
        <span class="scb-export-title">Export Hangar Data</span>
        <button class="scb-popup-close">&times;</button>
      </div>
      <div class="scb-export-body">
        <div class="scb-export-section">
          <div class="scb-export-section-label">Data to include</div>
          <div class="scb-export-categories">${categoryHtml}</div>
        </div>
        <div class="scb-export-section">
          <div class="scb-export-section-label">Format</div>
          <div class="scb-export-formats">
            <label class="scb-export-format">
              <input type="radio" name="scb-format" value="json" checked />
              <span>JSON</span>
              <span class="scb-export-format-desc">Full fidelity, nested structure</span>
            </label>
            <label class="scb-export-format">
              <input type="radio" name="scb-format" value="csv" />
              <span>CSV</span>
              <span class="scb-export-format-desc">Flat, one row per pledge</span>
            </label>
          </div>
        </div>
        <div class="scb-export-note">
          ${isFiltered
            ? `Exports ${count} of ${inventory.length} pledges (filtered).`
            : `Exports all ${count} pledges.`}
          <br/>Want XLSX or Google Sheets? Export from your profile on <a href="https://scbridge.app" target="_blank" class="scb-export-link">scbridge.app</a>
        </div>
      </div>
      <div class="scb-export-footer">
        <button class="scb-action-btn" id="scb-export-cancel">Cancel</button>
        <button class="scb-action-btn scb-sync-btn" id="scb-export-go">Export</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const escapeHandler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", escapeHandler);
  };
  overlay.querySelector(".scb-popup-backdrop")?.addEventListener("click", close);
  overlay.querySelector(".scb-popup-close")?.addEventListener("click", close);
  overlay.querySelector("#scb-export-cancel")?.addEventListener("click", close);
  document.addEventListener("keydown", escapeHandler);

  overlay.querySelector("#scb-export-go")?.addEventListener("click", () => {
    const cats: Record<string, boolean> = {};
    overlay.querySelectorAll<HTMLInputElement>("input[data-cat]").forEach((cb) => {
      cats[cb.dataset.cat!] = cb.checked;
    });
    const format = (overlay.querySelector('input[name="scb-format"]:checked') as HTMLInputElement)?.value ?? "json";

    // Start data collection with progress UI
    startDataCollection(overlay, format as "json" | "csv", cats);
  });
}

async function startDataCollection(
  overlay: HTMLElement,
  format: "json" | "csv",
  categories: Record<string, boolean>,
) {
  const body = overlay.querySelector(".scb-export-body")!;
  const footer = overlay.querySelector(".scb-export-footer")!;
  const pledgeData = filtered.map((e) => e.data);

  // Determine which categories need fetching
  const steps: { key: string; label: string; needsFetch: boolean }[] = [
    { key: "fleet", label: "Fleet & Pledges", needsFetch: false },
    { key: "buyback", label: "Buy-Back Pledges", needsFetch: true },
    { key: "upgrades", label: "Upgrade History", needsFetch: true },
    { key: "account", label: "Account Info", needsFetch: true },
    { key: "shipNames", label: "Custom Ship Names", needsFetch: false },
  ];

  const activeSteps = steps.filter((s) => categories[s.key] !== false);
  const needsCollection = activeSteps.some((s) => s.needsFetch);

  if (!needsCollection) {
    // No fetching needed — export immediately
    const close = () => overlay.remove();
    close();
    const collected: CollectedData = {
      pledges: pledgeData,
      buybackPledges: [],
      upgrades: [],
      account: null,
      namedShips: collectNamedShips(pledgeData),
    };
    runExport(format, categories, collected);
    return;
  }

  // Replace body with progress UI
  body.innerHTML = `
    <div class="scb-collect-progress">
      <div class="scb-collect-title">Collecting data...</div>
      <div class="scb-collect-steps">
        ${activeSteps.map((s) => `
          <div class="scb-collect-step" data-step="${s.key}">
            <span class="scb-collect-icon">&#x23F3;</span>
            <span class="scb-collect-label">${s.label}</span>
            <span class="scb-collect-detail" data-detail="${s.key}"></span>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  // Disable footer buttons during collection
  footer.innerHTML = `
    <button class="scb-action-btn" id="scb-export-cancel" disabled>Collecting...</button>
  `;

  function updateStep(key: string, status: "pending" | "collecting" | "done" | "error" | "skipped", detail?: string) {
    const stepEl = overlay.querySelector(`.scb-collect-step[data-step="${key}"]`);
    if (!stepEl) return;
    const iconEl = stepEl.querySelector(".scb-collect-icon")!;
    const detailEl = stepEl.querySelector(".scb-collect-detail")!;

    stepEl.className = `scb-collect-step scb-step-${status}`;
    switch (status) {
      case "collecting": iconEl.textContent = "\u23F3"; break;
      case "done": iconEl.textContent = "\u2705"; break;
      case "error": iconEl.textContent = "\u274C"; break;
      case "skipped": iconEl.textContent = "\u23ED"; break;
      default: iconEl.textContent = "\u23F3"; break;
    }
    if (detail) detailEl.textContent = detail;
  }

  // Collect data
  const collected: CollectedData = {
    pledges: pledgeData,
    buybackPledges: [],
    upgrades: [],
    account: null,
    namedShips: [],
  };

  // Fleet — instant
  if (categories.fleet !== false) {
    updateStep("fleet", "done", `${pledgeData.length} pledges`);
  }

  // Ship names — instant
  if (categories.shipNames !== false) {
    collected.namedShips = collectNamedShips(pledgeData);
    updateStep("shipNames", "done", collected.namedShips.length > 0 ? `${collected.namedShips.length} named` : "None");
  }

  // Account info — single fetch
  if (categories.account !== false) {
    updateStep("account", "collecting", "Fetching...");
    try {
      collected.account = await collectAccountInfo((d) => updateStep("account", "collecting", d));
      updateStep("account", collected.account ? "done" : "error", collected.account ? "Done" : "Not found");
    } catch {
      updateStep("account", "error", "Failed");
    }
  }

  // Buy-back pledges — paginated
  if (categories.buyback !== false) {
    updateStep("buyback", "collecting", "Fetching...");
    try {
      collected.buybackPledges = await collectBuyBackPledges((d) => updateStep("buyback", "collecting", d));
      updateStep("buyback", "done", collected.buybackPledges.length > 0 ? `${collected.buybackPledges.length} found` : "None");
    } catch {
      updateStep("buyback", "error", "Failed");
    }
  }

  // Upgrade logs — multiple API calls
  if (categories.upgrades !== false) {
    const upgradeCount = pledgeData.filter((p) => p.hasUpgradeLog).length;
    if (upgradeCount === 0) {
      updateStep("upgrades", "done", "No upgrade logs");
    } else {
      updateStep("upgrades", "collecting", `0/${upgradeCount}`);
      try {
        collected.upgrades = await collectUpgradeLogs(
          pledgeData,
          (d) => updateStep("upgrades", "collecting", d),
        );
        updateStep("upgrades", "done", `${collected.upgrades.length} entries`);
      } catch {
        updateStep("upgrades", "error", "Failed");
      }
    }
  }

  // Done — update footer
  const title = overlay.querySelector(".scb-collect-title");
  if (title) title.textContent = "Collection complete!";

  footer.innerHTML = `
    <button class="scb-action-btn" id="scb-export-cancel">Close</button>
    <button class="scb-action-btn scb-sync-btn" id="scb-export-download">Download ${format.toUpperCase()}</button>
  `;

  const close = () => overlay.remove();
  footer.querySelector("#scb-export-cancel")?.addEventListener("click", close);
  footer.querySelector("#scb-export-download")?.addEventListener("click", () => {
    close();
    runExport(format, categories, collected);
  });
}

function runExport(format: "json" | "csv", categories: Record<string, boolean>, collected: CollectedData) {
  const { pledges: data, buybackPledges, upgrades: upgradeEntries, account, namedShips } = collected;
  const timestamp = new Date().toISOString().slice(0, 10);

  if (format === "json") {
    const jsonData: Record<string, unknown> = {};

    if (categories.fleet !== false) {
      jsonData.pledges = data.map((p) => ({
        id: p.id, name: p.name, value: p.value, valueCents: p.valueCents,
        configurationValue: p.configurationValue, currency: p.currency, date: p.date,
        is_upgraded: p.isUpgraded, is_giftable: p.isGiftable, is_reclaimable: p.isReclaimable,
        has_upgrade_log: p.hasUpgradeLog, has_lti: p.hasLti, is_warbond: p.isWarbond,
        is_reward: p.isReward, availability: p.availability,
        insurance_type: p.insuranceType,
        items: p.items.map((i) => ({
          title: i.title, kind: i.kind, manufacturer: i.manufacturer,
          manufacturerCode: i.manufacturerCode, customName: i.customName,
          serial: i.serial, isNameable: i.isNameable,
        })),
        nameableShips: p.nameableShips, nameReservations: p.nameReservations,
        upgradeData: p.upgradeData,
      }));
    }

    if (categories.upgrades !== false && upgradeEntries.length > 0) {
      jsonData.upgrade_logs = upgradeEntries;
    }

    if (categories.buyback !== false && buybackPledges.length > 0) {
      jsonData.buyback_pledges = buybackPledges;
    }

    if (categories.account !== false && account) {
      jsonData.account = account;
    }

    if (categories.shipNames !== false && namedShips.length > 0) {
      jsonData.named_ships = namedShips;
    }

    jsonData.export_meta = {
      exported_at: new Date().toISOString(),
      pledge_count: data.length,
      buyback_count: buybackPledges.length,
      upgrade_log_count: upgradeEntries.length,
      named_ship_count: namedShips.length,
      has_account: !!account,
      categories,
    };

    downloadFile(JSON.stringify(jsonData, null, 2), `sc-bridge-hangar-${timestamp}.json`, "application/json");
  } else {
    // CSV — multiple sections
    const rows: string[] = [];

    if (categories.fleet !== false) {
      rows.push("# Pledges");
      rows.push("id,name,value,currency,date,lti,warbond,giftable,meltable,upgraded,has_upgrade_log,availability,items");
      for (const p of data) {
        rows.push([
          p.id, csvEscape(p.name), (p.valueCents / 100).toFixed(2), csvEscape(p.currency),
          csvEscape(p.date), p.hasLti, p.isWarbond, p.isGiftable, p.isReclaimable,
          p.isUpgraded, p.hasUpgradeLog, csvEscape(p.availability),
          csvEscape(p.items.map((i) => i.title).join("; ")),
        ].join(","));
      }
    }

    if (categories.buyback !== false && buybackPledges.length > 0) {
      if (rows.length > 0) rows.push("");
      rows.push("# Buy-Back Pledges");
      rows.push("id,name,value,date,items,is_credit_reclaimable,token_cost");
      for (const b of buybackPledges) {
        rows.push([
          b.id, csvEscape(b.name), csvEscape(b.value), csvEscape(b.date),
          csvEscape(b.items.map((i) => i.title).join("; ")),
          b.is_credit_reclaimable, b.token_cost ?? "",
        ].join(","));
      }
    }

    if (categories.upgrades !== false && upgradeEntries.length > 0) {
      if (rows.length > 0) rows.push("");
      rows.push("# Upgrade Logs");
      rows.push("pledge_id,name,applied_at,new_value");
      for (const u of upgradeEntries) {
        rows.push([
          u.pledge_id, csvEscape(u.name), csvEscape(u.applied_at), csvEscape(u.new_value),
        ].join(","));
      }
    }

    if (categories.account !== false && account) {
      if (rows.length > 0) rows.push("");
      rows.push("# Account Info");
      rows.push("field,value");
      rows.push(`nickname,${csvEscape(account.nickname)}`);
      rows.push(`displayname,${csvEscape(account.displayname)}`);
      if (account.avatar_url) rows.push(`avatar_url,${csvEscape(account.avatar_url)}`);
      if (account.enlisted_since) rows.push(`enlisted_since,${csvEscape(account.enlisted_since)}`);
      if (account.country) rows.push(`country,${csvEscape(account.country)}`);
      if (account.concierge_level) rows.push(`concierge_level,${csvEscape(account.concierge_level)}`);
      if (account.concierge_next_level) rows.push(`concierge_next_level,${csvEscape(account.concierge_next_level)}`);
      if (account.concierge_progress != null) rows.push(`concierge_progress,${account.concierge_progress}%`);
      if (account.subscriber_type) rows.push(`subscriber_type,${csvEscape(account.subscriber_type)}`);
      if (account.subscriber_frequency) rows.push(`subscriber_frequency,${csvEscape(account.subscriber_frequency)}`);
      if (account.store_credit_cents != null) rows.push(`store_credit,$${(account.store_credit_cents / 100).toFixed(2)}`);
      if (account.uec_balance != null) rows.push(`uec_balance,${account.uec_balance}`);
      if (account.rec_balance != null) rows.push(`rec_balance,${account.rec_balance}`);
      if (account.has_game_package != null) rows.push(`has_game_package,${account.has_game_package}`);
      if (account.referral_code) rows.push(`referral_code,${csvEscape(account.referral_code)}`);
      if (account.orgs?.length) {
        for (const o of account.orgs) {
          const parts = [`${csvEscape(o.name)} [${o.sid}]`];
          if (o.rank) parts.push(`rank: ${o.rank}`);
          if (o.members) parts.push(o.members);
          if (o.is_primary) parts.push("*main*");
          rows.push(`org,${csvEscape(parts.join(" | "))}`);
        }
      } else if (account.org) {
        rows.push(`org,${csvEscape(account.org.name)} [${account.org.sid}]${account.org.rank ? ` (${account.org.rank})` : ""} *main*`);
      }
      if (account.featured_badges?.length) {
        for (const b of account.featured_badges) {
          rows.push(`featured_badge,${csvEscape(b.title)}`);
        }
      }
      if (account.all_badges) {
        const badgeNames = Object.values(account.all_badges).sort();
        rows.push(`badge_count,${badgeNames.length}`);
        rows.push(`badges,${csvEscape(badgeNames.join("; "))}`);
      }
    }

    if (categories.shipNames !== false && namedShips.length > 0) {
      if (rows.length > 0) rows.push("");
      rows.push("# Named Ships");
      rows.push("membership_id,default_name,custom_name");
      for (const s of namedShips) {
        rows.push([s.membership_id, csvEscape(s.default_name), csvEscape(s.custom_name)].join(","));
      }
    }

    if (rows.length === 0) return;
    downloadFile(rows.join("\n"), `sc-bridge-hangar-${timestamp}.csv`, "text/csv");
  }
}

// ── Sync ──

async function triggerSync() {
  const apiBase = await getApiBase();
  window.open(`${apiBase}/sync-import`, "_blank");
}
