/**
 * Popup UI controller — shows connection status and links to settings.
 */

import {
  getApiBase,
  getEnvOverride,
  setEnvOverride,
  type EnvKey,
} from "@/lib/constants";
import { isRsiLoggedIn } from "@/lib/rsi-client";

// ── Elements ──

const mainScreen = document.getElementById("main-screen")!;
const devtoolsScreen = document.getElementById("devtools-screen")!;
const settingsLink = document.getElementById("settings-link") as HTMLAnchorElement;
const rsiStatus = document.getElementById("rsi-status")!;
const scbridgeStatus = document.getElementById("scbridge-status")!;
const lastSyncSection = document.getElementById("last-sync-section")!;
const lastSyncTime = document.getElementById("last-sync-time")!;
const envBadge = document.getElementById("env-badge")!;

const devtoolsBackBtn = document.getElementById("devtools-back-btn")!;
const devtoolsApplyBtn = document.getElementById("devtools-apply-btn")!;
const devtoolsCurrent = document.getElementById("devtools-current")!;

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

async function checkScBridgeSession(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/api/auth/get-session`, {
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = await res.json() as { session?: unknown };
    return !!data?.session;
  } catch {
    return false;
  }
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
    checkScBridgeSession(apiBase),
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
