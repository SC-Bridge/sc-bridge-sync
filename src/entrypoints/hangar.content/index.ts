/**
 * Content script — enhances the RSI hangar/pledges page with
 * filter buttons, search, total spend, and export capabilities.
 *
 * Like HangarXplor, we collect the actual <li> DOM nodes from every
 * page and move them in/out of the native .list-items container.
 * RSI's exchange, gift, and upgrade buttons survive because the
 * nodes are never destroyed — just repositioned.
 */

import "./style.css";
import type { RsiPledge, RsiPledgeItem, RsiUpgradeData, NamedShip, RsiAccountInfo, RsiUpgrade, RsiBuyBackPledge, RsiOrgInfo, RsiBadgeDisplay, SyncPayload } from "@/lib/types";
import { SYNC_CATEGORIES, RSI_API, RSI_REQUEST_DELAY_MS } from "@/lib/constants";
import { csvEscape, downloadFile } from "@/lib/export";

// ── Filter Types ──

type FilterKey =
  | "ships"
  | "ccus"
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

const FILTERS: { key: FilterKey; label: string; group: "content" | "status" }[] = [
  { key: "ships", label: "Ships", group: "content" },
  { key: "ccus", label: "CCUs", group: "content" },
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
let loading = true;
let nativeList: HTMLElement | null = null;

function getLocale(): string {
  const match = window.location.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//i);
  return match ? match[1] : "en";
}

/** Remove RSI's native pagination controls wherever they appear */
function hidePager() {
  document.querySelectorAll<HTMLElement>(".js-pager, .pager-container, .pagination").forEach((el) => {
    el.remove();
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
    // Listen for background-triggered collect requests (bridge sync flow)
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

    console.log("[SC Bridge] Hangar enhancement loaded");
    waitForPledgeList();
  },
});

// ── Initialization ──

function waitForPledgeList() {
  if (tryInit()) return;
  const observer = new MutationObserver(() => {
    if (tryInit()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30_000);
}

function tryInit(): boolean {
  const list = document.querySelector(".list-items") as HTMLElement | null;
  if (!list) return false;
  if (document.getElementById("scb-toolbar")) return true;

  console.log("[SC Bridge] Found .list-items, injecting toolbar");
  nativeList = list;

  // Collect page 1's native <li> nodes into inventory
  collectNodesFromContainer(nativeList);

  injectToolbar();

  // Hide RSI's native pagination — prevents page navigation during load.
  // The pager may not exist yet (RSI renders it after the list), so also
  // watch for it with a MutationObserver.
  hidePager();
  const pagerObserver = new MutationObserver(() => { hidePager(); });
  pagerObserver.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => pagerObserver.disconnect(), 30_000);

  loadAllPages();
  return true;
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
 */
function enhancePledgeNode(li: HTMLLIElement, pledge: RsiPledge) {
  if (li.dataset.scbEnhanced) return;
  li.dataset.scbEnhanced = "1";

  const h3 = li.querySelector("h3");
  if (!h3) return;

  // ── Clean up the title ──
  // Strip RSI pledge prefixes to show the actual content name
  let displayName = pledge.name
    .replace(/^Standalone\s+Ships?\s*-\s*/i, "")
    .replace(/^Package\s*-\s*/i, "")
    .replace(/^Upgrade\s*-\s*/i, "CCU: ")
    .replace(/^Add-Ons\s*-\s*/i, "")
    .replace(/^Combo\s*-\s*/i, "")
    .trim();

  // For ship pledges, show the actual ship name (handles CCU'd ships)
  const ship = pledge.items.find((i) => i.kind === "Ship" || i.kind === "Vehicle");
  if (ship && !displayName.startsWith("CCU:")) {
    displayName = ship.customName
      ? `${ship.customName} (${ship.title})`
      : ship.title;
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

  // ── Inject "Base Pledge" for upgraded ships ──
  if (pledge.isUpgraded && ship) {
    // Extract original ship name from the pledge name
    const baseName = pledge.name
      .replace(/^Standalone\s+Ships?\s*-\s*/i, "")
      .replace(/^Package\s*-\s*/i, "")
      .replace(/^Add-Ons\s*-\s*/i, "")
      .replace(/^Combo\s*-\s*/i, "")
      .trim();

    if (baseName !== ship.title) {
      const baseEl = document.createElement("div");
      baseEl.className = "scb-base-pledge";
      baseEl.textContent = `Base Pledge: ${baseName}`;
      h3.parentElement?.insertBefore(baseEl, h3.nextSibling);
    }
  }

  // ── Update the pledge image to show the current ship/item ──
  const imgEl = li.querySelector(".image, .thumbnail") as HTMLElement | null;

  // Find the best image: ship item first, then any item with an image
  const itemImage = ship?.image ?? pledge.items.find((i) => i.image)?.image;
  const fullUrl = itemImage
    ? (itemImage.startsWith("http") ? itemImage : `https://robertsspaceindustries.com${itemImage}`)
    : null;

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
    imgWrap.appendChild(fullImg);
  };
  fullImg.onerror = () => {
    loadingEl.textContent = "";
  };
  fullImg.src = largeUrl;

  document.body.appendChild(overlay);

  // Close on backdrop click, close button, or Escape
  backdrop.addEventListener("click", () => overlay.remove());
  closeBtn.addEventListener("click", () => overlay.remove());
  document.addEventListener("keydown", function handler(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", handler);
    }
  });
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

  const labels = li.querySelectorAll(".availability, .label");
  const isGiftable = Array.from(labels).some(
    (el) => el.textContent?.trim() === "Gift",
  );

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

  const hasLti = items.some(
    (i) => i.kind === "Insurance" &&
      (i.title.includes("Lifetime") || i.title.includes("LTI")),
  );
  const isWarbond = /warbond/i.test(name);
  const nameUpper = name.toUpperCase();
  const isReward =
    nameUpper.includes("REWARD") || nameUpper.includes("REFERRAL") ||
    nameUpper.includes("PROMOTIONAL") || nameUpper.includes("SUBSCRIBER") ||
    nameUpper.includes("FLAIR");

  return {
    id, name, value, valueCents, configurationValue, currency, date,
    isUpgraded, isGiftable, isReclaimable, hasUpgradeLog,
    hasLti, isWarbond, isReward, availability,
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
  updateLoadingState(true, "Loading all pledges...");

  const locale = getLocale();
  const t0 = performance.now();

  // Track which IDs we already have from page 1
  const existingIds = new Set(inventory.map((e) => e.data.id));

  try {
    const probePages = Array.from({ length: PROBE_BATCH }, (_, i) => i + 1);
    updateLoadingState(true, `Loading pages 1–${PROBE_BATCH}...`);

    const probeResults = await concurrentMap(
      probePages,
      (p) => fetchPageNodes(locale, p),
      { concurrency: 5 },
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
      const maxPage = 500;
      const remaining = Array.from(
        { length: maxPage - PROBE_BATCH },
        (_, i) => PROBE_BATCH + 1 + i,
      );
      updateLoadingState(true, `Loading remaining pages...`);

      const remainResults = await concurrentMap(
        remaining,
        (p) => fetchPageNodes(locale, p),
        { concurrency: 5, shouldStop: (entries) => entries.length === 0 },
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
  } catch (err) {
    console.error("[SC Bridge] Failed to load all pages:", err);
  }

  loading = false;
  updateLoadingState(false);
  hidePager();

  applyFilters();
}

/** Fetch a page's HTML, parse the <li> nodes, and adopt them into the live document */
async function fetchPageNodes(locale: string, page: number): Promise<PledgeEntry[]> {
  const url = `${window.location.origin}/${locale}/account/pledges?page=${page}`;
  const response = await fetch(url, { credentials: "same-origin" });
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
}

// ── Toolbar ──

function injectToolbar() {
  const toolbar = document.createElement("div");
  toolbar.id = "scb-toolbar";
  toolbar.innerHTML = `
    <div class="scb-toolbar-row">
      <div class="scb-filters">
        <button class="scb-filter-btn scb-filter-all active" data-filter="all">All</button>
        ${FILTERS.filter((f) => f.group === "content").map(
          (f) => `<button class="scb-filter-btn" data-filter="${f.key}">${f.label}</button>`,
        ).join("")}
        <span class="scb-filter-sep"></span>
        ${FILTERS.filter((f) => f.group === "status").map(
          (f) => `<button class="scb-filter-btn" data-filter="${f.key}">${f.label}</button>`,
        ).join("")}
      </div>
    </div>
    <div class="scb-filter-hint">Click = solo filter &middot; Shift+click = combine &middot; Ctrl+click = exclude</div>
    <div class="scb-toolbar-row scb-search-row">
      <input type="text" class="scb-search" placeholder="Search pledges..." />
    </div>
    <div class="scb-toolbar-row scb-total-row">
      <span class="scb-total-label">Total Pledge Value:</span>
      <span class="scb-total-value" id="scb-total">loading...</span>
    </div>
    <div class="scb-toolbar-row scb-detail-row">
      <span class="scb-pledge-count" id="scb-count"></span>
      <div class="scb-actions">
        <button class="scb-action-btn" id="scb-export-btn">Export</button>
        <button class="scb-action-btn scb-sync-btn" id="scb-sync" title="Sync to SC Bridge">
          Sync to SC Bridge
        </button>
      </div>
    </div>
    <div id="scb-loading" class="scb-loading">Loading all pledges...</div>
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

  // Search
  const searchInput = toolbar.querySelector<HTMLInputElement>(".scb-search");
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase().trim();
    applyFilters();
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

function applyFilters() {
  filtered = inventory.filter(({ data }) => {
    for (const filter of includeFilters) {
      if (!matchesFilter(data, filter)) return false;
    }
    for (const filter of excludeFilters) {
      if (matchesFilter(data, filter)) return false;
    }
    if (searchQuery) {
      const text = `${data.name} ${data.items.map((i) => i.title).join(" ")}`.toLowerCase();
      if (!text.includes(searchQuery)) return false;
    }
    return true;
  });

  updateStats();
  render();
}

/**
 * Empty the native .list-items and append the filtered nodes back in.
 * The DOM nodes are never destroyed — RSI's event listeners survive.
 */
function render() {
  if (!nativeList) return;

  // Detach all children (moves nodes out, doesn't destroy them)
  while (nativeList.firstChild) {
    nativeList.removeChild(nativeList.firstChild);
  }

  // Append the filtered subset
  for (const { node } of filtered) {
    nativeList.appendChild(node);
  }
}

// ── Stats ──

function updateLoadingState(isLoading: boolean, message?: string) {
  const el = document.getElementById("scb-loading");
  if (el) {
    el.style.display = isLoading ? "block" : "none";
    if (message) el.textContent = message;
  }
}

function updateStats() {
  const totalEl = document.getElementById("scb-total");
  const countEl = document.getElementById("scb-count");
  if (!totalEl || !countEl) return;

  const allData = inventory.map((e) => e.data);
  const filteredData = filtered.map((e) => e.data);

  const totalAll = allData.reduce((sum, p) => sum + p.valueCents, 0);
  const totalFiltered = filteredData.reduce((sum, p) => sum + p.valueCents, 0);

  totalEl.textContent = formatCurrency(totalAll / 100);

  if (filteredData.length < allData.length) {
    countEl.textContent = `Showing ${filteredData.length} of ${allData.length} pledges — ${formatCurrency(totalFiltered / 100)}`;
  } else {
    countEl.textContent = `${allData.length} pledges`;
  }

  // Filter button counts
  const allBtnEl = document.querySelector<HTMLButtonElement>(".scb-filter-all");
  if (allBtnEl) allBtnEl.textContent = `All (${allData.length})`;

  const hasActiveFilters = includeFilters.size > 0 || excludeFilters.size > 0;
  document.querySelectorAll<HTMLButtonElement>(".scb-filter-btn:not(.scb-filter-all)").forEach((btn) => {
    const key = btn.dataset.filter as FilterKey;
    const total = allData.filter((p) => matchesFilter(p, key)).length;
    const label = FILTERS.find((f) => f.key === key)?.label ?? key;

    if (hasActiveFilters) {
      const current = filteredData.filter((p) => matchesFilter(p, key)).length;
      btn.textContent = `${label} (${current}/${total})`;
    } else {
      btn.textContent = `${label} (${total})`;
    }
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
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

/** Run async tasks with bounded concurrency + delay between launches. */
async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  {
    concurrency = 5,
    delayMs = RSI_REQUEST_DELAY_MS,
    shouldStop,
  }: {
    concurrency?: number;
    delayMs?: number;
    shouldStop?: (result: R, index: number) => boolean;
  } = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  let stopped = false;
  let lastDispatchAt = 0;

  async function worker() {
    while (!stopped && idx < items.length) {
      const i = idx++;
      // Global rate limit: wait until delayMs has passed since last dispatch
      const now = Date.now();
      const wait = Math.max(0, delayMs - (now - lastDispatchAt));
      if (wait > 0) await delay(wait);
      lastDispatchAt = Date.now();
      results[i] = await fn(items[i]);
      if (shouldStop?.(results[i], i)) {
        stopped = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Background-Triggered Collection (Bridge Sync Flow) ──

async function handleCollectAll(): Promise<SyncPayload> {
  // Wait for initial pagination to finish (loading becomes false)
  const deadline = Date.now() + 120_000; // 2 min — large hangars (600+ pledges) need time
  while (loading) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for hangar data to load");
    }
    await new Promise((r) => setTimeout(r, 500));
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
    const response = await fetch("/en/account/dashboard", { credentials: "same-origin" });
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
      const orgResponse = await fetch("/en/account/organization", { credentials: "same-origin" });
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

async function collectUpgradeLogs(
  pledges: RsiPledge[],
  onProgress: (detail: string) => void,
): Promise<RsiUpgrade[]> {
  const upgradeable = pledges.filter((p) => p.hasUpgradeLog);
  if (upgradeable.length === 0) {
    onProgress("No upgrade logs");
    return [];
  }

  const upgrades: RsiUpgrade[] = [];

  for (let i = 0; i < upgradeable.length; i++) {
    const pledge = upgradeable[i];
    onProgress(`${i + 1}/${upgradeable.length}`);

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

    if (i < upgradeable.length - 1) await delay(RSI_REQUEST_DELAY_MS);
  }

  onProgress("Done");
  return upgrades;
}

async function collectBuyBackPledges(
  onProgress: (detail: string) => void,
): Promise<RsiBuyBackPledge[]> {
  // The old REST API (/api/account/buyBackPledges) returns 500 on the new platform.
  // Scrape the server-rendered HTML pages instead — same approach community tools use.
  const buybacks: RsiBuyBackPledge[] = [];
  let page = 1;
  const maxPages = 100;
  const pageSize = 100;

  try {
    while (page <= maxPages) {
      onProgress(`Page ${page}...`);

      const locale = getLocale();
      const response = await fetch(
        `${window.location.origin}/${locale}/account/buy-back-pledges?page=${page}&pagesize=${pageSize}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        console.warn(`[SC Bridge] Buyback page ${page} returned ${response.status}`);
        break;
      }

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const pledgeEls = doc.querySelectorAll("article.pledge");
      if (pledgeEls.length === 0) break;

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
        let containedText = "";
        for (const dt of dts) {
          const label = dt.textContent?.trim() ?? "";
          const dd = dt.nextElementSibling as HTMLElement | null;
          const val = dd?.textContent?.trim() ?? "";
          if (label === "Last Modified") date = val;
          if (label === "Contained") containedText = val;
        }

        // "Contained" shows the upgraded state, not the original pledge — skip it.
        // The pledge name IS the meaningful data for buyback.
        const items: RsiPledgeItem[] = [];

        // Reclaimable if the buyback button link exists — the .unavailable div is always
        // in the DOM but hidden via display:none when the pledge can be bought back
        const isCreditReclaimable = !!buybackLink;

        buybacks.push({
          id,
          name,
          value: "$0.00",
          value_cents: 0,
          date,
          items,
          is_credit_reclaimable: isCreditReclaimable,
        });
      }

      // Check if there are more pages — look for next page link in pager
      const pagerLinks = doc.querySelectorAll(".pager a, .js-pager a");
      let hasNext = false;
      for (const link of pagerLinks) {
        const href = link.getAttribute("href") ?? link.getAttribute("rel") ?? "";
        if (href.includes(`page=${page + 1}`)) {
          hasNext = true;
          break;
        }
      }
      // Also check: if we got a full page of results, there might be more
      if (!hasNext && pledgeEls.length >= pageSize) {
        hasNext = true;
      }

      if (!hasNext) break;
      page++;
      await delay(RSI_REQUEST_DELAY_MS);
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

  const close = () => overlay.remove();
  overlay.querySelector(".scb-popup-backdrop")?.addEventListener("click", close);
  overlay.querySelector(".scb-popup-close")?.addEventListener("click", close);
  overlay.querySelector("#scb-export-cancel")?.addEventListener("click", close);
  document.addEventListener("keydown", function handler(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", handler); }
  });

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

function triggerSync() {
  // Redirect to the SC Bridge import page where the actual sync happens
  window.open("https://scbridge.app/sync-import", "_blank");
}
