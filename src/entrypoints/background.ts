/**
 * Background service worker — orchestrates the sync process.
 *
 * MV3 service workers are non-persistent. State is checkpointed to
 * browser.storage.local so sync can resume after termination.
 */

import { isRsiLoggedIn, getRsiToken } from "@/lib/rsi-client";
import { isScBridgeLoggedIn } from "@/lib/sc-bridge-client";
import { getLastSync, hasConsent, isCategoryEnabled } from "@/lib/storage";
import { getApiBase } from "@/lib/constants";
import { fetchSpectrumFriends } from "@/lib/spectrum";
import type { ExtensionMessage, SyncPayload } from "@/lib/types";

const LAST_PAYLOAD_KEY = "last_sync_payload";
const FRIENDS_ALARM = "spectrum-friends-sync";

function isCollectError(v: unknown): v is { type: "COLLECT_ERROR"; error: string } {
  return typeof v === "object" && v !== null && (v as { type?: string }).type === "COLLECT_ERROR";
}

export default defineBackground(() => {
  /** Handle messages from the popup and content scripts */
  browser.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse) => {
      if (message.type === "GET_STATUS") {
        handleGetStatus().then(sendResponse);
        return true; // async response
      }

      if (message.type === "GET_RSI_TOKEN") {
        getRsiToken().then((token) => sendResponse({ token }));
        return true;
      }

      if (message.type === "GET_LAST_PAYLOAD") {
        getLastPayload().then(sendResponse);
        return true;
      }

      if (message.type === "BRIDGE_COLLECT_HANGAR") {
        handleBridgeCollect().then(sendResponse);
        return true;
      }

      if (message.type === "SYNC_SPECTRUM_FRIENDS") {
        handleSyncSpectrumFriends().then(sendResponse);
        return true;
      }
    },
  );

  async function getLastPayload() {
    const result = await browser.storage.local.get(LAST_PAYLOAD_KEY);
    return {
      type: "LAST_PAYLOAD" as const,
      payload: (result[LAST_PAYLOAD_KEY] as SyncPayload) ?? null,
    };
  }

  async function saveLastPayload(payload: SyncPayload) {
    await browser.storage.local.set({ [LAST_PAYLOAD_KEY]: payload });
  }

  async function handleBridgeCollect(): Promise<
    { type: "COLLECT_RESULT"; payload: SyncPayload } | { type: "COLLECT_ERROR"; error: string }
  > {
    try {
      const rsiOk = await isRsiLoggedIn();
      if (!rsiOk) {
        return { type: "COLLECT_ERROR", error: "Not logged into RSI" };
      }

      // Find an existing RSI pledges tab
      const existingTabs = await browser.tabs.query({
        url: "*://robertsspaceindustries.com/*/account/pledges*",
      });

      let tabId: number;
      let isNewTab = false;

      if (existingTabs.length > 0 && existingTabs[0].id != null) {
        tabId = existingTabs[0].id;
        if (existingTabs[0].status !== "complete") {
          await waitForTabComplete(tabId);
        }
      } else {
        const newTab = await browser.tabs.create({
          url: "https://robertsspaceindustries.com/en/account/pledges",
          active: false,
        });
        if (newTab.id == null) {
          return { type: "COLLECT_ERROR", error: "Failed to create RSI tab" };
        }
        tabId = newTab.id;
        isNewTab = true;
        await waitForTabComplete(tabId);
      }

      // Send collect command to the hangar content script.
      // If the tab was open before the extension was installed/reloaded, the content
      // script won't be injected. Detect this and reload the tab to trigger injection.
      let result: unknown;
      let reloaded = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          result = await browser.tabs.sendMessage(tabId, { type: "COLLECT_ALL_DATA" });
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);

          // Content script not injected — reload the tab once to trigger injection
          if (!reloaded && errMsg.includes("Could not establish connection")) {
            await browser.tabs.reload(tabId);
            await waitForTabComplete(tabId);
            // Wait for content script to init after page load
            await new Promise((r) => setTimeout(r, 3000));
            reloaded = true;
            continue;
          }

          if (attempt === 3) throw err;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      if (isCollectError(result)) {
        return result;
      }

      // Save the payload for later retrieval
      const payload = result as SyncPayload;
      await saveLastPayload(payload);

      return { type: "COLLECT_RESULT", payload };
    } catch (err) {
      return {
        type: "COLLECT_ERROR",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.tabs.onUpdated.removeListener(listener);
        reject(new Error("Timed out waiting for RSI tab to load"));
      }, timeoutMs);

      function listener(
        updatedTabId: number,
        changeInfo: browser.Tabs.OnUpdatedChangeInfoType,
      ) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          clearTimeout(timer);
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }

      browser.tabs.onUpdated.addListener(listener);
    });
  }

  async function handleSyncSpectrumFriends(): Promise<
    { type: "SPECTRUM_FRIENDS_RESULT"; count: number; selfHandle: string } |
    { type: "SPECTRUM_FRIENDS_ERROR"; error: string }
  > {
    try {
      // Check prerequisites
      const apiBase = await getApiBase();
      const [rsiOk, scBridgeOk] = await Promise.all([
        isRsiLoggedIn(),
        isScBridgeLoggedIn(apiBase),
      ]);

      if (!rsiOk) {
        return { type: "SPECTRUM_FRIENDS_ERROR", error: "Not logged into RSI" };
      }
      if (!scBridgeOk) {
        return { type: "SPECTRUM_FRIENDS_ERROR", error: "Not logged into SC Bridge" };
      }

      // Fetch from Spectrum
      const { friends, selfHandle } = await fetchSpectrumFriends();

      if (friends.length === 0) {
        return { type: "SPECTRUM_FRIENDS_RESULT", count: 0, selfHandle };
      }

      // Upload to SC Bridge (using session cookies via credentials: "include")
      const response = await fetch(`${apiBase}/api/companion/sync/friends`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ friends }),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          type: "SPECTRUM_FRIENDS_ERROR",
          error: `SC Bridge API error: ${response.status} — ${text.slice(0, 200)}`,
        };
      }

      return { type: "SPECTRUM_FRIENDS_RESULT", count: friends.length, selfHandle };
    } catch (err) {
      return {
        type: "SPECTRUM_FRIENDS_ERROR",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function handleGetStatus() {
    const apiBase = await getApiBase();
    const [rsiLoggedIn, scBridgeLoggedIn, consentGiven, lastSync] = await Promise.all([
      isRsiLoggedIn(),
      isScBridgeLoggedIn(apiBase),
      hasConsent(),
      getLastSync(),
    ]);

    return {
      type: "STATUS" as const,
      rsiLoggedIn,
      scBridgeLoggedIn,
      consentGiven,
      lastSync,
    };
  }


  // ── Spectrum Friends Auto-Sync (60s alarm) ──

  // Syncs friends whenever logged into both RSI and SC Bridge.
  // periodInMinutes minimum is 1 for MV3 — runs every 60s.
  browser.alarms.create(FRIENDS_ALARM, { periodInMinutes: 1 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== FRIENDS_ALARM) return;

    const friendsEnabled = await isCategoryEnabled("spectrumFriends");
    if (!friendsEnabled) return;

    const rsiOk = await isRsiLoggedIn();
    if (!rsiOk) return;

    try {
      const result = await handleSyncSpectrumFriends();
      if (result.type === "SPECTRUM_FRIENDS_ERROR") {
        console.warn("[friends-sync]", result.error);
      }
    } catch (err) {
      console.warn("[friends-sync] alarm handler error:", err);
    }
  });
});
