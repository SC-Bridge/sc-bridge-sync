/**
 * Popup UI controller — shows connection status and links to settings.
 */

import {
  getApiBase,
  getEnvOverride,
  setEnvOverride,
  type EnvKey,
} from "@/lib/constants";
import { isScBridgeLoggedIn } from "@/lib/sc-bridge-client";
import { isRsiLoggedIn } from "@/lib/rsi-client";
import { getPrivacyMode, setPrivacyMode, getStealthPercent, setStealthPercent } from "@/lib/storage";

// ── Elements ──

function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[SC Bridge] Missing popup element: #${id}`);
  return el as T;
}

const mainScreen = getEl("main-screen");
const devtoolsScreen = getEl("devtools-screen");
const settingsLink = getEl<HTMLAnchorElement>("settings-link");
const rsiStatus = getEl("rsi-status");
const scbridgeStatus = getEl("scbridge-status");
const lastSyncSection = getEl("last-sync-section");
const lastSyncTime = getEl("last-sync-time");
const envBadge = getEl("env-badge");

const devtoolsBackBtn = getEl("devtools-back-btn");
const devtoolsApplyBtn = getEl("devtools-apply-btn");
const devtoolsCurrent = getEl("devtools-current");

// ── Screen Management ──

function showScreen(screen: "main" | "devtools") {
  mainScreen.classList.toggle("hidden", screen !== "main");
  devtoolsScreen.classList.toggle("hidden", screen !== "devtools");
}

// ── Status ──

function setBadge(
  el: HTMLElement,
  text: string,
  variant: "ok" | "warn" | "off",
) {
  el.textContent = text;
  el.className = `badge badge-${variant}`;
}

async function refreshStatus() {
  const apiBase = await getApiBase();
  const envOverride = await getEnvOverride();

  // Update settings link
  settingsLink.href = `${apiBase}/sync-import`;

  // Show environment badge if not production
  if (envOverride === "staging") {
    envBadge.textContent = "STAGING";
    envBadge.classList.remove("hidden");
  } else {
    envBadge.classList.add("hidden");
  }

  // Check RSI
  setBadge(rsiStatus, "checking...", "off");
  setBadge(scbridgeStatus, "checking...", "off");

  const [rsiOk, scbridgeOk] = await Promise.all([
    isRsiLoggedIn(),
    isScBridgeLoggedIn(apiBase),
  ]);

  if (rsiOk) {
    setBadge(rsiStatus, "Connected", "ok");
  } else {
    setBadge(rsiStatus, "Not logged in", "warn");
  }

  if (scbridgeOk) {
    setBadge(scbridgeStatus, "Connected", "ok");
  } else {
    setBadge(scbridgeStatus, "Not logged in", "warn");
  }

  // Last sync (from extension storage)
  try {
    const result = await browser.storage.local.get("last_sync_at");
    const lastSync = result["last_sync_at"] as string | undefined;
    if (lastSync) {
      lastSyncSection.classList.remove("hidden");
      lastSyncTime.textContent = new Date(lastSync).toLocaleString();
    } else {
      lastSyncSection.classList.add("hidden");
    }
  } catch {
    lastSyncSection.classList.add("hidden");
  }
}

// ── Privacy Mode ──

const stealthSettings = getEl("stealth-settings");
const stealthSlider = getEl<HTMLInputElement>("stealth-slider");
const stealthValue = getEl("stealth-value");
const stealthPreview = getEl("stealth-preview");

function updateStealthPreview(pct: number) {
  stealthValue.textContent = `${pct}%`;
  const example = Math.round(1000 * pct / 100);
  stealthPreview.textContent = `A $1,000 ship will display as $${example.toLocaleString()}`;
}

async function initPrivacyMode() {
  const mode = await getPrivacyMode();
  const pct = await getStealthPercent();

  // Set initial radio
  const radios = document.querySelectorAll('input[name="privacy-mode"]') as NodeListOf<HTMLInputElement>;
  for (const radio of radios) {
    radio.checked = radio.value === mode;
  }

  // Set initial slider
  stealthSlider.value = String(pct);
  updateStealthPreview(pct);
  stealthSettings.classList.toggle("hidden", mode !== "stealth");

  // Radio change
  const modesContainer = getEl("privacy-modes");
  modesContainer.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement;
    const newMode = target.value as "off" | "hidden" | "stealth";
    await setPrivacyMode(newMode);
    stealthSettings.classList.toggle("hidden", newMode !== "stealth");
  });

  // Slider change
  stealthSlider.addEventListener("input", async () => {
    const newPct = parseInt(stealthSlider.value, 10);
    updateStealthPreview(newPct);
    await setStealthPercent(newPct);
  });
}

// ── Dev Tools (Ctrl+Shift+D) ──

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "D") {
    e.preventDefault();
    openDevTools();
  }
});

async function openDevTools() {
  const currentEnv = await getEnvOverride();
  const activeEnv = currentEnv ?? "production";

  const radios = document.querySelectorAll('input[name="dev-env"]') as NodeListOf<HTMLInputElement>;
  for (const radio of radios) {
    radio.checked = radio.value === activeEnv;
  }

  const apiBase = await getApiBase();
  devtoolsCurrent.textContent = `Current: ${apiBase}`;

  showScreen("devtools");
}

devtoolsBackBtn.addEventListener("click", () => {
  showScreen("main");
});

devtoolsApplyBtn.addEventListener("click", async () => {
  const selected = document.querySelector('input[name="dev-env"]:checked') as HTMLInputElement;
  if (!selected) return;

  const env = selected.value as EnvKey;
  await setEnvOverride(env);

  showScreen("main");
  await refreshStatus();
});

// ── Init ──

refreshStatus();
initPrivacyMode();
