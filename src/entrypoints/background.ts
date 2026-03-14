/**
 * Background service worker — orchestrates the sync process.
 *
 * MV3 service workers are non-persistent. State is checkpointed to
 * browser.storage.local so sync can resume after termination.
 */

import { isRsiLoggedIn } from "@/lib/rsi-client";
import { getAuthToken, getLastSync, hasConsent } from "@/lib/storage";
import type { ExtensionMessage } from "@/lib/types";

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
    },
  );

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

  function sendProgress(phase: string, detail: string, percent: number) {
    browser.runtime.sendMessage({
      type: "SYNC_PROGRESS",
      phase,
      detail,
      percent,
    });
  }
});
