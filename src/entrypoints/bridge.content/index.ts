/**
 * Bridge content script — runs on scbridge.app pages.
 * Relays postMessage ↔ background service worker.
 */

const ALLOWED_ORIGINS = [
  "https://scbridge.app",
  "https://staging.scbridge.app",
  ...(import.meta.env.MODE === "development" ? ["http://localhost:5173"] : []),
];

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function sendToBackground(message: Record<string, unknown>): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await browser.runtime.sendMessage(message);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConnectionError =
        msg.includes("Could not establish connection") ||
        msg.includes("Receiving end does not exist");

      if (!isConnectionError || attempt === MAX_RETRIES) {
        throw err;
      }

      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw new Error("Failed to reach extension background");
}

export default defineContentScript({
  matches: [
    "https://scbridge.app/*",
    "https://staging.scbridge.app/*",
    // localhost is injected via wxt.config.ts content_scripts override in dev mode only
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
          const response = (await sendToBackground({
            type: "BRIDGE_COLLECT_HANGAR",
          })) as { type: string; error?: string; payload?: unknown } | null;

          if (response?.type === "COLLECT_ERROR") {
            window.postMessage(
              {
                type: "SCBRIDGE_SYNC_RESPONSE",
                success: false,
                error: response.error,
                source: "sc-bridge-sync",
              },
              event.origin,
            );
          } else {
            window.postMessage(
              {
                type: "SCBRIDGE_SYNC_RESPONSE",
                success: true,
                payload: response?.payload ?? response,
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
