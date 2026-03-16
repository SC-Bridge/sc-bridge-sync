/**
 * Background service worker — orchestrates the sync process.
 *
 * MV3 service workers are non-persistent. State is checkpointed to
 * browser.storage.local so sync can resume after termination.
 */

import { isRsiLoggedIn, getRsiToken } from "@/lib/rsi-client";
import { getAuthToken, getLastSync, hasConsent } from "@/lib/storage";
import type { ExtensionMessage, SyncPayload } from "@/lib/types";

const LAST_PAYLOAD_KEY = "last_sync_payload";

export default defineBackground(() => {
  console.log("[SC Bridge BG] Background service worker started");

  /** Current sync state (in-memory, backed by storage checkpoints) */
  let syncing = false;
  let lastError: string | null = null;

  /** Handle messages from the popup and content scripts */
  browser.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse) => {
      console.log("[SC Bridge BG] Message received:", message.type, "from:", _sender?.tab?.url || _sender?.url || "unknown");

      if (message.type === "GET_STATUS") {
        handleGetStatus().then(sendResponse);
        return true; // async response
      }

      if (message.type === "START_SYNC") {
        handleStartSync().then(sendResponse);
        return true;
      }

      if (message.type === "CANCEL_SYNC") {
        syncing = false;
        sendResponse({ ok: true });
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
      console.log("[SC Bridge BG] handleBridgeCollect started");

      const rsiOk = await isRsiLoggedIn();
      console.log("[SC Bridge BG] RSI logged in:", rsiOk);
      if (!rsiOk) {
        return { type: "COLLECT_ERROR", error: "Not logged into RSI" };
      }

      // Find an existing RSI pledges tab
      const existingTabs = await browser.tabs.query({
        url: "*://robertsspaceindustries.com/*/account/pledges*",
      });
      console.log("[SC Bridge BG] Existing RSI tabs:", existingTabs.length, existingTabs.map((t) => ({ id: t.id, url: t.url, status: t.status })));

      let tabId: number;
      let isNewTab = false;

      if (existingTabs.length > 0 && existingTabs[0].id != null) {
        tabId = existingTabs[0].id;
        console.log("[SC Bridge BG] Using existing tab:", tabId, "status:", existingTabs[0].status);
        if (existingTabs[0].status !== "complete") {
          console.log("[SC Bridge BG] Waiting for tab to complete...");
          await waitForTabComplete(tabId);
        }
      } else {
        console.log("[SC Bridge BG] No RSI tab found, creating new one...");
        const newTab = await browser.tabs.create({
          url: "https://robertsspaceindustries.com/en/account/pledges",
          active: false,
        });
        if (newTab.id == null) {
          return { type: "COLLECT_ERROR", error: "Failed to create RSI tab" };
        }
        tabId = newTab.id;
        isNewTab = true;
        console.log("[SC Bridge BG] Created tab:", tabId, "waiting for load...");
        await waitForTabComplete(tabId);
        console.log("[SC Bridge BG] Tab loaded");
      }

      // Content scripts inject at document_idle — give a brief window after tab load
      if (isNewTab) {
        console.log("[SC Bridge BG] New tab — waiting 2s for content script injection...");
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Check the tab's actual URL (RSI might have redirected)
      const tabInfo = await browser.tabs.get(tabId);
      console.log("[SC Bridge BG] Tab URL after load:", tabInfo.url, "status:", tabInfo.status);

      // Send collect command to the hangar content script.
      // If the tab was open before the extension was installed/reloaded, the content
      // script won't be injected. Detect this and reload the tab to trigger injection.
      let result: unknown;
      let reloaded = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          console.log("[SC Bridge BG] tabs.sendMessage attempt", attempt + 1, "to tab", tabId);
          result = await browser.tabs.sendMessage(tabId, { type: "COLLECT_ALL_DATA" });
          console.log("[SC Bridge BG] tabs.sendMessage success:", (result as Record<string, unknown>)?.type || typeof result);
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log("[SC Bridge BG] tabs.sendMessage attempt", attempt + 1, "failed:", errMsg);

          // Content script not injected — reload the tab once to trigger injection
          if (!reloaded && errMsg.includes("Could not establish connection")) {
            console.log("[SC Bridge BG] Reloading tab to inject content script...");
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

      if (result?.type === "COLLECT_ERROR") {
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

  async function handleGetStatus() {
    const [rsiLoggedIn, authToken, consentGiven, lastSync] = await Promise.all([
      isRsiLoggedIn(),
      getAuthToken(),
      hasConsent(),
      getLastSync(),
    ]);

    return {
      type: "STATUS" as const,
      rsiLoggedIn,
      scBridgeLoggedIn: authToken !== null,
      consentGiven,
      syncing,
      lastSync,
      error: lastError,
    };
  }

  async function handleStartSync() {
    if (syncing) {
      return { ok: false, error: "Sync already in progress" };
    }

    const consent = await hasConsent();
    if (!consent) {
      return { ok: false, error: "Consent not given" };
    }

    const token = await getAuthToken();
    if (!token) {
      return { ok: false, error: "Not logged into SC Bridge" };
    }

    const rsiOk = await isRsiLoggedIn();
    if (!rsiOk) {
      return { ok: false, error: "Not logged into RSI" };
    }

    syncing = true;
    lastError = null;

    // Sync runs asynchronously — progress sent via runtime messages
    runSync().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      syncing = false;
      browser.runtime.sendMessage({
        type: "SYNC_ERROR",
        error: lastError,
      });
    });

    return { ok: true };
  }

  async function runSync() {
    // TODO: Implement the full sync pipeline
    // Phase 1: Fetch all pledges (paginated HTML scraping)
    // Phase 2: Fetch upgrade logs for upgraded pledges
    // Phase 3: Fetch account info
    // Phase 4: Extract named ships from pledge items
    // Phase 5: Upload to SC Bridge API

    sendProgress("Starting", "Preparing sync...", 0);

    // Placeholder — will be implemented in subsequent commits
    sendProgress("Complete", "Sync not yet implemented", 100);

    syncing = false;
    const timestamp = new Date().toISOString();
    browser.runtime.sendMessage({
      type: "SYNC_COMPLETE",
      timestamp,
    });
  }

  function sendProgress(phase: string, detail: string, percent: number) {
    browser.runtime.sendMessage({
      type: "SYNC_PROGRESS",
      phase,
      detail,
      percent,
    });
  }
});
