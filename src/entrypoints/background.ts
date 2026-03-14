/**
 * Background service worker — orchestrates the sync process.
 *
 * MV3 service workers are non-persistent. State is checkpointed to
 * browser.storage.local so sync can resume after termination.
 */

import { isRsiLoggedIn, rsiPost, rsiDelay } from "@/lib/rsi-client";
import { getAuthToken, getLastSync, hasConsent } from "@/lib/storage";
import { RSI_API } from "@/lib/constants";
import type { ExtensionMessage, SyncPayload } from "@/lib/types";

const LAST_PAYLOAD_KEY = "last_sync_payload";

export default defineBackground(() => {
  /** Current sync state (in-memory, backed by storage checkpoints) */
  let syncing = false;
  let lastError: string | null = null;

  /** Handle messages from the popup */
  browser.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse) => {
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

      if (message.type === "GET_LAST_PAYLOAD") {
        getLastPayload().then(sendResponse);
        return true;
      }

      if (message.type === "FETCH_ALL_PLEDGE_VALUES") {
        fetchAllPledgeValues().then(sendResponse);
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
    // Phase 1: Fetch all pledges (paginated)
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

  /**
   * Fetch all pledge pages from RSI and calculate total spend.
   * Used by the content script to display total across all pages.
   */
  async function fetchAllPledgeValues() {
    try {
      const rsiOk = await isRsiLoggedIn();
      if (!rsiOk) {
        return { totalSpend: 0, pledgeCount: 0, error: "Not logged in" };
      }

      let page = 1;
      let totalSpend = 0;
      let pledgeCount = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await rsiPost<{
          data?: { pledges?: Array<{ value?: string; amount?: number }> };
          success?: number;
        }>(RSI_API.pledges, { page, pagesize: 100 });

        const pledges = response?.data?.pledges ?? [];
        if (pledges.length === 0) {
          hasMore = false;
          break;
        }

        for (const pledge of pledges) {
          pledgeCount++;
          // Value is typically "$X.XX" or a numeric string
          const valStr = pledge.value ?? "";
          const match = valStr.toString().replace(/[$,]/g, "");
          const num = parseFloat(match);
          if (!isNaN(num)) {
            totalSpend += num;
          }
        }

        // RSI pages are 1-indexed; stop if we got fewer than requested
        if (pledges.length < 100) {
          hasMore = false;
        } else {
          page++;
          await rsiDelay();
        }
      }

      return { totalSpend, pledgeCount };
    } catch (err) {
      console.error("[SC Bridge] Failed to fetch all pledge values:", err);
      return { totalSpend: 0, pledgeCount: 0, error: String(err) };
    }
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
