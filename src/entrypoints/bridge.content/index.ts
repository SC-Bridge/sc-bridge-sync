/**
 * Bridge content script — runs on scbridge.app pages.
 *
 * SYNC FLOW (service-worker-free):
 * The sync uses browser.storage as a mailbox to communicate between this
 * content script (on scbridge.app) and the hangar content script (on RSI).
 * This avoids routing through the MV3 background service worker, which
 * Edge/Chrome aggressively kill after ~30s of inactivity — causing
 * "message channel closed" errors during long syncs (500+ pledge hangars).
 *
 * Flow:
 * 1. SC Bridge page sends SCBRIDGE_SYNC_REQUEST via postMessage
 * 2. This script writes { command: "collect" } to browser.storage.local
 * 3. Hangar content script (on RSI tab) detects the storage change
 * 4. Hangar content script collects all data (can take minutes)
 * 5. Hangar content script writes the payload to browser.storage.local
 * 6. This script detects the storage change and reads the payload
 * 7. This script postMessages the payload back to the SC Bridge page
 * 8. SC Bridge page POSTs to /api/import/hangar-sync (same-origin)
 *
 * The background service worker is NOT involved in the sync flow at all.
 */

const ALLOWED_ORIGINS = [
  "https://scbridge.app",
  "https://staging.scbridge.app",
  ...(import.meta.env.MODE === "development" ? ["http://localhost:5173"] : []),
];

const SYNC_MAILBOX_COMMAND = "scb_sync_command";
const SYNC_MAILBOX_RESULT = "scb_sync_result";
const SYNC_TIMEOUT_MS = 600_000; // 10 minutes — large hangars need time

export default defineContentScript({
  matches: [
    "https://scbridge.app/*",
    "https://staging.scbridge.app/*",
  ],

  main() {
    console.log("[SC Bridge] Bridge content script loaded");

    window.addEventListener("message", async (event) => {
      if (!ALLOWED_ORIGINS.includes(event.origin)) return;
      if (event.source !== window) return;

      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "SCBRIDGE_PING") {
        const version = browser.runtime.getManifest().version;
        window.postMessage(
          {
            type: "SCBRIDGE_PONG",
            version,
            source: "sc-bridge-sync",
          },
          event.origin,
        );
        return;
      }

      if (data.type === "SCBRIDGE_SYNC_REQUEST") {
        try {
          const payload = await collectViaMailbox();

          if (payload) {
            window.postMessage(
              {
                type: "SCBRIDGE_SYNC_RESPONSE",
                success: true,
                payload,
                source: "sc-bridge-sync",
              },
              event.origin,
            );
          } else {
            window.postMessage(
              {
                type: "SCBRIDGE_SYNC_RESPONSE",
                success: false,
                error: "No payload received from hangar — is the RSI pledges page open?",
                source: "sc-bridge-sync",
              },
              event.origin,
            );
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          window.postMessage(
            {
              type: "SCBRIDGE_SYNC_RESPONSE",
              success: false,
              error: errMsg,
              source: "sc-bridge-sync",
            },
            event.origin,
          );
        }
        return;
      }
    });
  },
});

/**
 * Trigger collection via browser.storage mailbox pattern.
 * Writes a command, then waits for the hangar content script to write the result.
 * No background service worker involved — immune to MV3 service worker termination.
 */
async function collectViaMailbox(): Promise<unknown> {
  // Clear any stale result from a previous sync
  await browser.storage.local.remove(SYNC_MAILBOX_RESULT);

  // Write command — the hangar content script is listening for this
  await browser.storage.local.set({
    [SYNC_MAILBOX_COMMAND]: { action: "collect", timestamp: Date.now() },
  });

  // Wait for the hangar content script to write the result
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.storage.onChanged.removeListener(listener);
      reject(new Error("Sync timed out — the hangar content script took too long to respond. Is the RSI pledges page open?"));
    }, SYNC_TIMEOUT_MS);

    function listener(
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      area: string,
    ) {
      if (area !== "local" || !changes[SYNC_MAILBOX_RESULT]) return;

      clearTimeout(timeout);
      browser.storage.onChanged.removeListener(listener);

      const result = changes[SYNC_MAILBOX_RESULT].newValue as { payload?: unknown; error?: string } | undefined;
      if (result?.error) {
        reject(new Error(result.error));
      } else if (result?.payload) {
        resolve(result.payload);
      } else {
        reject(new Error("Invalid result from hangar content script"));
      }

      // Clean up mailbox
      browser.storage.local.remove([SYNC_MAILBOX_COMMAND, SYNC_MAILBOX_RESULT]);
    }

    browser.storage.onChanged.addListener(listener);
  });
}
