/** SC Bridge API base URL */
export const API_BASE =
  import.meta.env.MODE === "development"
    ? "http://localhost:8787"
    : "https://scbridge.app";

/** RSI API base URL */
export const RSI_BASE = "https://robertsspaceindustries.com";

/** RSI API endpoints (all POST) */
export const RSI_API = {
  /** List pledges (paginated) */
  pledges: "/api/account/pledges",
  /** Upgrade log for a specific pledge */
  upgradeLog: "/api/account/upgradeLog",
  /** Account info */
  accountInfo: "/api/account/v2/setAuthToken",
  /** Org info */
  orgInfo: "/api/account/getOrgInfo",
} as const;

/** Delay between RSI API requests (ms) — be respectful */
export const RSI_REQUEST_DELAY_MS = 400;

/** Extension storage keys */
export const STORAGE_KEYS = {
  /** SC Bridge auth token */
  authToken: "scbridge_auth_token",
  /** Last sync timestamp */
  lastSync: "last_sync_at",
  /** Whether user has completed onboarding consent */
  consentGiven: "consent_given",
  /** In-progress sync checkpoint */
  syncCheckpoint: "sync_checkpoint",
} as const;
