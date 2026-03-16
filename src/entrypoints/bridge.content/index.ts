/**
 * Bridge content script — runs on scbridge.app pages.
 * Verbose logging enabled for debugging.
 */

const ALLOWED_ORIGINS = [
  "https://scbridge.app",
  "https://staging.scbridge.app",
  "http://localhost:5173",
];

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

const log = (...args: unknown[]) => console.log("[SC Bridge Bridge]", ...args);

async function sendToBackground(message: Record<string, unknown>): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      log(`sendToBackground attempt ${attempt + 1}/${MAX_RETRIES + 1}:`, message.type);
      const result = await browser.runtime.sendMessage(message);
      log(`sendToBackground success:`, result?.type || typeof result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`sendToBackground attempt ${attempt + 1} failed:`, msg);
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
    "http://localhost:5173/*",
  ],

  main() {
    log("Bridge content script loaded on", window.location.href);
    log("Extension ID:", browser.runtime.id);
    log("Extension version:", browser.runtime.getManifest().version);

    window.addEventListener("message", async (event) => {
      // Log ALL messages for debugging
      if (event.data && typeof event.data === "object" && event.data.type) {
        log("postMessage heard:", event.data.type, "from origin:", event.origin, "source===window:", event.source === window);
      }

      if (!ALLOWED_ORIGINS.includes(event.origin)) {
        if (event.data?.type?.startsWith?.("SCBRIDGE_")) {
          log("REJECTED — origin not allowed:", event.origin);
        }
        return;
      }

      if (event.source !== window) {
        if (event.data?.type?.startsWith?.("SCBRIDGE_")) {
          log("REJECTED — source !== window");
        }
        return;
      }

      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "SCBRIDGE_PING") {
        log("PING received — responding with PONG");
        const version = browser.runtime.getManifest().version;
        window.postMessage(
          {
            type: "SCBRIDGE_PONG",
            version,
            source: "sc-bridge-sync",
          },
          event.origin,
        );
        log("PONG sent with version:", version);
        return;
      }

      if (data.type === "SCBRIDGE_SYNC_REQUEST") {
        log("SYNC_REQUEST received — forwarding to background");
        try {
          const response = (await sendToBackground({
            type: "BRIDGE_COLLECT_HANGAR",
          })) as { type: string; error?: string; payload?: unknown } | null;

          log("Background responded:", response?.type);

          if (response?.type === "COLLECT_ERROR") {
            log("Background returned error:", response.error);
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
            log("Background returned payload, forwarding to page");
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
          log("Background communication failed:", errMsg);
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

    log("Message listener installed");
  },
});
