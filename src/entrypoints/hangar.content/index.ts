/**
 * Content script — enhances the RSI hangar/pledges page with
 * filter buttons, search, total spend, and export capabilities.
 *
 * Injected into https://robertsspaceindustries.com/account/pledges
 */

import "./style.css";

// ── Types ──

interface PledgeCard {
  el: HTMLElement;
  title: string;
  value: number;
  tags: Set<string>;
}

type FilterKey =
  | "lti"
  | "warbond"
  | "giftable"
  | "meltable"
  | "upgraded"
  | "valuable"
  | "reward";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "lti", label: "LTI" },
  { key: "warbond", label: "Warbond" },
  { key: "giftable", label: "Giftable" },
  { key: "meltable", label: "Meltable" },
  { key: "upgraded", label: "Upgraded" },
  { key: "valuable", label: "Valuable" },
  { key: "reward", label: "Reward" },
];

/** Dollar threshold for "Valuable" filter */
const VALUABLE_THRESHOLD = 100;

// ── State ──

let parsedCards: PledgeCard[] = [];
let activeFilters = new Set<FilterKey>();
let searchQuery = "";
let totalSpendAll = 0;
let totalSpendVisible = 0;
let allPagesFetched = false;
let toolbar: HTMLElement | null = null;
let statsPanel: HTMLElement | null = null;

// ── Content Script Definition ──

export default defineContentScript({
  matches: [
    "https://robertsspaceindustries.com/account/pledges*",
  ],
  runAt: "document_idle",

  main() {
    console.log("[SC Bridge] Hangar enhancement loaded");
    waitForPledgeList();
  },
});

// ── DOM Discovery ──

/**
 * Wait for the pledge list to appear in the DOM.
 * RSI loads content dynamically, so we observe mutations.
 */
function waitForPledgeList() {
  const found = tryInject();
  if (found) return;

  const observer = new MutationObserver(() => {
    if (tryInject()) {
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Safety timeout — stop observing after 30s
  setTimeout(() => observer.disconnect(), 30_000);
}

/**
 * Try to find the pledge list and inject our toolbar.
 * Returns true if successful.
 */
function tryInject(): boolean {
  // RSI pledge list selectors — try multiple patterns
  const container = findPledgeContainer();
  if (!container) return false;

  // Don't inject twice
  if (document.getElementById("scb-toolbar")) return true;

  console.log("[SC Bridge] Found pledge container, injecting toolbar");
  injectToolbar(container);
  parsePledgeCards(container);
  updateStats();

  // Watch for RSI pagination / dynamic content changes
  observeContentChanges(container);

  // Fetch all pages for total spend in background
  fetchAllPledgesTotal();

  return true;
}

/**
 * Find the pledge list container using flexible selectors.
 * RSI's DOM structure may change — try multiple approaches.
 */
function findPledgeContainer(): HTMLElement | null {
  // Try common RSI patterns
  const selectors = [
    ".list-items",
    '[class*="pledge"] .list-items',
    ".inner-content .list-items",
    ".page-pledges .list-items",
    "#702702 .list-items",
  ];

  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }

  // Fallback: find by structure — look for a container with multiple
  // child elements that contain dollar signs and dates
  const candidates = document.querySelectorAll<HTMLElement>(
    ".inner-content > div, .page-wrapper div, main div",
  );
  for (const el of candidates) {
    const children = el.children;
    if (children.length >= 2) {
      let pledgeLikeCount = 0;
      for (let i = 0; i < Math.min(children.length, 5); i++) {
        const text = children[i].textContent ?? "";
        if (text.includes("$") && (text.includes("Melt") || text.includes("Contains"))) {
          pledgeLikeCount++;
        }
      }
      if (pledgeLikeCount >= 2) return el;
    }
  }

  return null;
}

// ── Toolbar Injection ──

function injectToolbar(container: HTMLElement) {
  toolbar = document.createElement("div");
  toolbar.id = "scb-toolbar";
  toolbar.innerHTML = `
    <div class="scb-toolbar-row">
      <div class="scb-filters">
        ${FILTERS.map(
          (f) =>
            `<button class="scb-filter-btn" data-filter="${f.key}">${f.label}</button>`,
        ).join("")}
      </div>
      <div class="scb-search-wrap">
        <input type="text" class="scb-search" placeholder="Search pledges..." />
      </div>
    </div>
    <div class="scb-toolbar-row scb-stats-row">
      <div class="scb-stats" id="scb-stats">
        <span class="scb-total-label">Total Spend:</span>
        <span class="scb-total-value" id="scb-total">calculating...</span>
        <span class="scb-pledge-count" id="scb-count"></span>
      </div>
      <div class="scb-actions">
        <button class="scb-action-btn" id="scb-export-csv" title="Download CSV">CSV</button>
        <button class="scb-action-btn" id="scb-export-json" title="Download JSON">JSON</button>
        <button class="scb-action-btn scb-sync-btn" id="scb-sync" title="Sync to SC Bridge">
          Sync to SC Bridge
        </button>
      </div>
    </div>
  `;

  container.parentElement?.insertBefore(toolbar, container);

  // Bind filter buttons
  toolbar.querySelectorAll<HTMLButtonElement>(".scb-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filter as FilterKey;
      if (activeFilters.has(key)) {
        activeFilters.delete(key);
        btn.classList.remove("active");
      } else {
        activeFilters.add(key);
        btn.classList.add("active");
      }
      applyFilters();
    });
  });

  // Bind search
  const searchInput = toolbar.querySelector<HTMLInputElement>(".scb-search");
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase().trim();
    applyFilters();
  });

  // Bind export buttons
  document.getElementById("scb-export-csv")?.addEventListener("click", () => exportData("csv"));
  document.getElementById("scb-export-json")?.addEventListener("click", () => exportData("json"));

  // Bind sync button
  document.getElementById("scb-sync")?.addEventListener("click", triggerSync);
}

// ── Pledge Card Parsing ──

function parsePledgeCards(container: HTMLElement) {
  parsedCards = [];

  // Find pledge card elements — try the direct children first,
  // then look for common item selectors
  let items = Array.from(container.querySelectorAll<HTMLElement>(
    ":scope > .list-item, :scope > li, :scope > div, :scope > article",
  ));

  // If container children are the items, use them directly
  if (items.length === 0) {
    items = Array.from(container.children) as HTMLElement[];
  }

  for (const el of items) {
    const text = el.textContent ?? "";

    // Skip if it doesn't look like a pledge (too short or no relevant content)
    if (text.length < 30) continue;

    const card = parseSingleCard(el, text);
    if (card) {
      el.dataset.scbIndex = String(parsedCards.length);
      parsedCards.push(card);
    }
  }

  console.log(`[SC Bridge] Parsed ${parsedCards.length} pledge cards`);
}

function parseSingleCard(el: HTMLElement, text: string): PledgeCard | null {
  const textUpper = text.toUpperCase();
  const tags = new Set<string>();

  // Extract title — look for heading elements or first significant text
  const heading = el.querySelector("h3, h4, .title, [class*='title'], [class*='name']");
  const title = heading?.textContent?.trim() ?? text.slice(0, 80).trim();

  // Extract melt/pledge value — look for dollar amounts
  const valueMatch = text.match(
    /(?:Melt\s*(?:Value)?|Value)[:\s]*\$?([\d,]+(?:\.\d{2})?)/i,
  );
  const value = valueMatch ? parseFloat(valueMatch[1].replace(/,/g, "")) : 0;

  // Classify tags based on text content
  if (
    textUpper.includes("LIFETIME") ||
    textUpper.includes("LTI") ||
    textUpper.includes("LIFE TIME")
  ) {
    tags.add("lti");
  }
  if (textUpper.includes("WARBOND")) {
    tags.add("warbond");
  }
  if (
    textUpper.includes("GIFTABLE") ||
    (textUpper.includes("GIFT") && !textUpper.includes("NOT GIFT"))
  ) {
    tags.add("giftable");
  }
  if (
    textUpper.includes("MELTABLE") ||
    textUpper.includes("RECLAIMABLE") ||
    textUpper.includes("RECLAIM")
  ) {
    tags.add("meltable");
  }
  if (textUpper.includes("UPGRADED")) {
    tags.add("upgraded");
  }
  if (value >= VALUABLE_THRESHOLD) {
    tags.add("valuable");
  }
  if (
    textUpper.includes("REWARD") ||
    textUpper.includes("REFERRAL") ||
    textUpper.includes("PROMOTIONAL")
  ) {
    tags.add("reward");
  }

  return { el, title, value, tags };
}

// ── Filtering ──

function applyFilters() {
  let visibleCount = 0;
  let visibleTotal = 0;

  for (const card of parsedCards) {
    let visible = true;

    // All active filters must match (AND logic)
    for (const filter of activeFilters) {
      if (!card.tags.has(filter)) {
        visible = false;
        break;
      }
    }

    // Search filter
    if (visible && searchQuery) {
      visible = card.title.toLowerCase().includes(searchQuery);
    }

    card.el.style.display = visible ? "" : "none";
    if (visible) {
      visibleCount++;
      visibleTotal += card.value;
    }
  }

  totalSpendVisible = visibleTotal;
  updateStats(visibleCount);
}

// ── Stats ──

function updateStats(visibleCount?: number) {
  const totalEl = document.getElementById("scb-total");
  const countEl = document.getElementById("scb-count");

  if (!totalEl || !countEl) return;

  if (allPagesFetched) {
    totalEl.textContent = formatCurrency(totalSpendAll);
    totalEl.title = "Total across all pages";
  } else {
    // Show page total while loading all pages
    const pageTotal = parsedCards.reduce((sum, c) => sum + c.value, 0);
    totalEl.textContent = formatCurrency(pageTotal);
    totalEl.title = "Current page total (loading all pages...)";
  }

  const total = parsedCards.length;
  const shown = visibleCount ?? total;
  if (shown < total) {
    countEl.textContent = `(${shown} of ${total} shown)`;
  } else {
    countEl.textContent = `(${total} pledges)`;
  }
}

function formatCurrency(cents_or_dollars: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents_or_dollars);
}

// ── All-Pages Fetch (via background) ──

async function fetchAllPledgesTotal() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "FETCH_ALL_PLEDGE_VALUES",
    });

    if (response && typeof response.totalSpend === "number") {
      totalSpendAll = response.totalSpend;
      allPagesFetched = true;
      updateStats();
      console.log(
        `[SC Bridge] All-pages total: ${formatCurrency(totalSpendAll)} (${response.pledgeCount} pledges)`,
      );
    }
  } catch (err) {
    console.warn("[SC Bridge] Could not fetch all-pages total:", err);
  }
}

// ── Export ──

function exportData(format: "csv" | "json") {
  const data = parsedCards.map((c) => ({
    title: c.title,
    value: c.value,
    tags: Array.from(c.tags),
    visible: c.el.style.display !== "none",
  }));

  const timestamp = new Date().toISOString().slice(0, 10);
  let content: string;
  let filename: string;
  let mime: string;

  if (format === "json") {
    content = JSON.stringify(data, null, 2);
    filename = `sc-bridge-hangar-${timestamp}.json`;
    mime = "application/json";
  } else {
    const header = "title,value,tags,visible";
    const rows = data.map(
      (d) =>
        `${csvEscape(d.title)},${d.value},"${d.tags.join("; ")}",${d.visible}`,
    );
    content = [header, ...rows].join("\n");
    filename = `sc-bridge-hangar-${timestamp}.csv`;
    mime = "text/csv";
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ── Sync ──

async function triggerSync() {
  const syncBtn = document.getElementById("scb-sync") as HTMLButtonElement | null;
  if (!syncBtn) return;

  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing...";

  try {
    const response = await browser.runtime.sendMessage({ type: "START_SYNC" });
    if (response?.ok) {
      syncBtn.textContent = "Sync Started!";
      setTimeout(() => {
        syncBtn.textContent = "Sync to SC Bridge";
        syncBtn.disabled = false;
      }, 3000);
    } else {
      syncBtn.textContent = response?.error ?? "Sync Failed";
      setTimeout(() => {
        syncBtn.textContent = "Sync to SC Bridge";
        syncBtn.disabled = false;
      }, 3000);
    }
  } catch {
    syncBtn.textContent = "Sync Failed";
    setTimeout(() => {
      syncBtn.textContent = "Sync to SC Bridge";
      syncBtn.disabled = false;
    }, 3000);
  }
}

// ── Content Change Observer ──

function observeContentChanges(container: HTMLElement) {
  const observer = new MutationObserver(() => {
    // Re-parse cards when RSI re-renders (e.g. pagination change)
    parsePledgeCards(container);
    if (activeFilters.size > 0 || searchQuery) {
      applyFilters();
    } else {
      updateStats();
    }
  });

  observer.observe(container, { childList: true });
}
