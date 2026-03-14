/**
 * Popup UI controller — manages screen transitions and user interactions.
 */

import { setConsent, hasConsent, setAuthToken, clearAuthToken } from "@/lib/storage";
import { API_BASE } from "@/lib/constants";
import type { ExtensionMessage } from "@/lib/types";

// ── Elements ──

const consentScreen = document.getElementById("consent-screen")!;
const loginScreen = document.getElementById("login-screen")!;
const mainScreen = document.getElementById("main-screen")!;

const consentBtn = document.getElementById("consent-btn")!;
const loginBtn = document.getElementById("login-btn")!;
const syncBtn = document.getElementById("sync-btn")!;
const logoutBtn = document.getElementById("logout-btn")!;

const emailInput = document.getElementById("email-input") as HTMLInputElement;
const passwordInput = document.getElementById(
  "password-input",
) as HTMLInputElement;
const loginError = document.getElementById("login-error")!;

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

function showScreen(screen: "consent" | "login" | "main") {
  consentScreen.classList.toggle("hidden", screen !== "consent");
  loginScreen.classList.toggle("hidden", screen !== "login");
  mainScreen.classList.toggle("hidden", screen !== "main");
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

  // Error
  if (status.error) {
    errorSection.classList.remove("hidden");
    errorText.textContent = status.error;
  } else {
    errorSection.classList.add("hidden");
  }
}

// ── Event Handlers ──

consentBtn.addEventListener("click", async () => {
  await setConsent(true);
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

refreshStatus();
