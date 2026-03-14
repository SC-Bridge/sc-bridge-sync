/**
 * Popup UI controller — manages screen transitions and user interactions.
 */

import {
  setConsent,
  setAuthToken,
  clearAuthToken,
  getSyncPreferences,
  setSyncPreferences,
  type SyncPreferences,
} from "@/lib/storage";
import { API_BASE, SYNC_CATEGORIES, type SyncCategoryKey } from "@/lib/constants";
import type { ExtensionMessage, SyncPayload } from "@/lib/types";
import { filterPayload, toJson, toCsv, downloadFile, type ExportFormat } from "@/lib/export";

// ── Elements ──

const consentScreen = document.getElementById("consent-screen")!;
const loginScreen = document.getElementById("login-screen")!;
const mainScreen = document.getElementById("main-screen")!;
const exportScreen = document.getElementById("export-screen")!;

const consentBtn = document.getElementById("consent-btn")!;
const loginBtn = document.getElementById("login-btn")!;
const syncBtn = document.getElementById("sync-btn")!;
const logoutBtn = document.getElementById("logout-btn")!;
const exportNavBtn = document.getElementById("export-nav-btn")!;
const exportBackBtn = document.getElementById("export-back-btn")!;
const exportBtn = document.getElementById("export-btn")!;
const exportError = document.getElementById("export-error")!;

const emailInput = document.getElementById("email-input") as HTMLInputElement;
const passwordInput = document.getElementById(
  "password-input",
) as HTMLInputElement;
const loginError = document.getElementById("login-error")!;

const categoryTogglesContainer = document.getElementById("category-toggles")!;
const mainCategoryTogglesContainer = document.getElementById(
  "main-category-toggles",
)!;
const exportCategoryTogglesContainer = document.getElementById(
  "export-category-toggles",
)!;

const rsiStatus = document.getElementById("rsi-status")!;
const scbridgeStatus = document.getElementById("scbridge-status")!;
const lastSyncSection = document.getElementById("last-sync-section")!;
const lastSyncTime = document.getElementById("last-sync-time")!;
const progressSection = document.getElementById("progress-section")!;
const progressFill = document.getElementById("progress-fill")!;
const progressText = document.getElementById("progress-text")!;
const errorSection = document.getElementById("error-section")!;
const errorText = document.getElementById("error-text")!;

// ── Screen Management ──

function showScreen(screen: "consent" | "login" | "main" | "export") {
  consentScreen.classList.toggle("hidden", screen !== "consent");
  loginScreen.classList.toggle("hidden", screen !== "login");
  mainScreen.classList.toggle("hidden", screen !== "main");
  exportScreen.classList.toggle("hidden", screen !== "export");
}

// ── Status Updates ──

function setBadge(
  el: HTMLElement,
  text: string,
  variant: "ok" | "warn" | "off",
) {
  el.textContent = text;
  el.className = `badge badge-${variant}`;
}

async function refreshStatus() {
  const status = (await browser.runtime.sendMessage({
    type: "GET_STATUS",
  })) as Extract<ExtensionMessage, { type: "STATUS" }>;

  if (!status.consentGiven) {
    showScreen("consent");
    return;
  }

  if (!status.scBridgeLoggedIn) {
    showScreen("login");
    return;
  }

  showScreen("main");

  // RSI status
  if (status.rsiLoggedIn) {
    setBadge(rsiStatus, "Connected", "ok");
  } else {
    setBadge(rsiStatus, "Not logged in", "warn");
  }

  // SC Bridge status
  setBadge(scbridgeStatus, "Connected", "ok");

  // Sync button
  syncBtn.disabled = !status.rsiLoggedIn || status.syncing;
  syncBtn.textContent = status.syncing ? "Syncing..." : "Sync Now";

  // Last sync
  if (status.lastSync) {
    lastSyncSection.classList.remove("hidden");
    lastSyncTime.textContent = new Date(status.lastSync).toLocaleString();
  } else {
    lastSyncSection.classList.add("hidden");
  }

  // Export button — enabled when there's been at least one sync
  (exportNavBtn as HTMLButtonElement).disabled = !status.lastSync;

  // Error
  if (status.error) {
    errorSection.classList.remove("hidden");
    errorText.textContent = status.error;
  } else {
    errorSection.classList.add("hidden");
  }
}

// ── Category Toggles ──

/**
 * Render category toggle checkboxes into a container.
 * `showDescriptions` controls whether the subtitle is visible (consent screen: yes, main screen: no).
 */
function renderCategoryToggles(
  container: HTMLElement,
  prefs: SyncPreferences,
  onChange: (key: SyncCategoryKey, checked: boolean) => void,
  showDescriptions: boolean,
) {
  container.innerHTML = "";

  for (const [key, cat] of Object.entries(SYNC_CATEGORIES)) {
    const label = document.createElement("label");
    label.className = "category-toggle";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = prefs[key as SyncCategoryKey];
    checkbox.dataset.category = key;
    checkbox.addEventListener("change", () => {
      onChange(key as SyncCategoryKey, checkbox.checked);
    });

    const info = document.createElement("span");
    info.className = "category-info";
    info.innerHTML = `<span class="category-label">${cat.label}</span>${
      showDescriptions
        ? `<span class="category-desc">${cat.description}</span>`
        : ""
    }`;

    label.appendChild(checkbox);
    label.appendChild(info);
    container.appendChild(label);
  }
}

/** Sync the checked state between consent and main toggle containers */
function syncToggleContainers(
  source: HTMLElement,
  target: HTMLElement,
  key: string,
  checked: boolean,
) {
  const targetCheckbox = target.querySelector(
    `input[data-category="${key}"]`,
  ) as HTMLInputElement | null;
  if (targetCheckbox) {
    targetCheckbox.checked = checked;
  }
}

/** Current in-memory prefs (loaded on init, persisted on change) */
let currentPrefs: SyncPreferences;

async function initToggles() {
  currentPrefs = await getSyncPreferences();

  const handleChange = async (key: SyncCategoryKey, checked: boolean) => {
    currentPrefs[key] = checked;
    await setSyncPreferences(currentPrefs);

    // Keep both containers in sync
    syncToggleContainers(
      categoryTogglesContainer,
      mainCategoryTogglesContainer,
      key,
      checked,
    );
    syncToggleContainers(
      mainCategoryTogglesContainer,
      categoryTogglesContainer,
      key,
      checked,
    );
  };

  renderCategoryToggles(categoryTogglesContainer, currentPrefs, handleChange, true);
  renderCategoryToggles(mainCategoryTogglesContainer, currentPrefs, handleChange, false);
}

// ── Event Handlers ──

consentBtn.addEventListener("click", async () => {
  await setConsent(true);
  // Preferences are already persisted via toggle onChange
  showScreen("login");
});

loginBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    loginError.textContent = "Email and password required";
    loginError.classList.remove("hidden");
    return;
  }

  loginBtn.textContent = "Logging in...";
  (loginBtn as HTMLButtonElement).disabled = true;
  loginError.classList.add("hidden");

  try {
    const res = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { message?: string }).message || `Login failed (${res.status})`,
      );
    }

    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new Error("No token in response");
    }

    await setAuthToken(data.token);
    await refreshStatus();
  } catch (err) {
    loginError.textContent =
      err instanceof Error ? err.message : "Login failed";
    loginError.classList.remove("hidden");
  } finally {
    loginBtn.textContent = "Log in";
    (loginBtn as HTMLButtonElement).disabled = false;
  }
});

syncBtn.addEventListener("click", async () => {
  progressSection.classList.remove("hidden");
  errorSection.classList.add("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "Starting...";

  await browser.runtime.sendMessage({ type: "START_SYNC" });
});

logoutBtn.addEventListener("click", async () => {
  await clearAuthToken();
  await refreshStatus();
});

// ── Export ──

/** Export preferences are independent of sync preferences — start with all on */
let exportPrefs: Record<SyncCategoryKey, boolean> = {
  fleet: true,
  buyback: true,
  upgrades: true,
  account: true,
  shipNames: true,
};

function getSelectedExportFormat(): ExportFormat {
  const checked = document.querySelector(
    'input[name="export-format"]:checked',
  ) as HTMLInputElement;
  return (checked?.value as ExportFormat) ?? "json";
}

function updateExportButtonState() {
  const anySelected = Object.values(exportPrefs).some(Boolean);
  (exportBtn as HTMLButtonElement).disabled = !anySelected;
}

function initExportToggles() {
  renderCategoryToggles(
    exportCategoryTogglesContainer,
    exportPrefs as SyncPreferences,
    (key, checked) => {
      exportPrefs[key] = checked;
      updateExportButtonState();
    },
    true,
  );
}

exportNavBtn.addEventListener("click", () => {
  // Reset export toggles to match current sync prefs each time
  exportPrefs = { ...currentPrefs };
  initExportToggles();
  exportError.classList.add("hidden");
  updateExportButtonState();
  showScreen("export");
});

exportBackBtn.addEventListener("click", () => {
  showScreen("main");
});

exportBtn.addEventListener("click", async () => {
  exportError.classList.add("hidden");
  (exportBtn as HTMLButtonElement).disabled = true;
  exportBtn.textContent = "Exporting...";

  try {
    const response = (await browser.runtime.sendMessage({
      type: "GET_LAST_PAYLOAD",
    })) as Extract<ExtensionMessage, { type: "LAST_PAYLOAD" }>;

    if (!response.payload) {
      throw new Error("No sync data available. Run a sync first.");
    }

    const filtered = filterPayload(
      response.payload,
      exportPrefs as Record<SyncCategoryKey, boolean>,
    );
    const format = getSelectedExportFormat();
    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      downloadFile(
        toJson(filtered),
        `sc-bridge-hangar-${timestamp}.json`,
        "application/json",
      );
    } else {
      downloadFile(
        toCsv(filtered),
        `sc-bridge-hangar-${timestamp}.csv`,
        "text/csv",
      );
    }
  } catch (err) {
    exportError.textContent =
      err instanceof Error ? err.message : "Export failed";
    exportError.classList.remove("hidden");
  } finally {
    exportBtn.textContent = "Export";
    updateExportButtonState();
  }
});

// ── Listen for progress updates from background ──

browser.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "SYNC_PROGRESS") {
    progressSection.classList.remove("hidden");
    progressFill.style.width = `${message.percent}%`;
    progressText.textContent = `${message.phase}: ${message.detail}`;
  }

  if (message.type === "SYNC_COMPLETE") {
    progressSection.classList.add("hidden");
    refreshStatus();
  }

  if (message.type === "SYNC_ERROR") {
    progressSection.classList.add("hidden");
    errorSection.classList.remove("hidden");
    errorText.textContent = message.error;
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync Now";
  }
});

// ── Init ──

initToggles();
refreshStatus();
