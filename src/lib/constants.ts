/** Default SC Bridge API base URL (compile-time) */
const DEFAULT_API_BASE =
  import.meta.env.MODE === "development"
    ? "http://localhost:8787"
    : import.meta.env.VITE_API_BASE || "https://scbridge.app";

/** Environment configs for dev tools switcher */
export const ENVIRONMENTS = {
  production: { label: "Production", url: "https://scbridge.app" },
  staging: { label: "Staging", url: "https://staging.scbridge.app" },
} as const;

export type EnvKey = keyof typeof ENVIRONMENTS;

/** Storage key for environment override */
const ENV_OVERRIDE_KEY = "dev_env_override";

/** Get the active API base URL (checks for dev tools override) */
export async function getApiBase(): Promise<string> {
  try {
    const result = await browser.storage.local.get(ENV_OVERRIDE_KEY);
    const override = result[ENV_OVERRIDE_KEY] as EnvKey | undefined;
    if (override && ENVIRONMENTS[override]) {
      return ENVIRONMENTS[override].url;
    }
  } catch {
    // storage not available (e.g. during build) — use default
  }
  return DEFAULT_API_BASE;
}

/** Get the active API base URL synchronously (for initial render — may be stale) */
export function getApiBaseSync(): string {
  return DEFAULT_API_BASE;
}

/** Set the environment override */
export async function setEnvOverride(env: EnvKey): Promise<void> {
  await browser.storage.local.set({ [ENV_OVERRIDE_KEY]: env });
}

/** Get the current environment override (or null for default) */
export async function getEnvOverride(): Promise<EnvKey | null> {
  const result = await browser.storage.local.get(ENV_OVERRIDE_KEY);
  return (result[ENV_OVERRIDE_KEY] as EnvKey) ?? null;
}

/** RSI website base URL */
export const RSI_BASE = "https://robertsspaceindustries.com";

/**
 * RSI API endpoints that actually work (all POST, require X-Rsi-Token header).
 *
 * Note: There is NO JSON API for pledges — /api/account/pledges returns 500.
 * Pledge data is scraped from the HTML pages at /account/pledges?page=N.
 */
export const RSI_API = {
  /** Buy-back pledges (paginated) */
  buybackPledges: "/api/account/buyBackPledges",
  /** Upgrade log for a specific pledge — returns HTML */
  upgradeLog: "/api/account/upgradeLog",
  /** JWT token for authenticated contexts */
  setAuthToken: "/api/account/v2/setAuthToken",
  /** Org info (public org search — not user memberships) */
  orgSearch: "/api/orgs/getOrgs",
  /** Pledge event log — returns HTML snippets */
  pledgeLog: "/api/account/pledgeLog",
  /** Credit transaction log */
  creditLog: "/api/account/creditLog",
  /** Badge list */
  badges: "/api/account/badge/getBadges",
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
  /** User's sync preferences (which data categories to include) */
  syncPreferences: "sync_preferences",
} as const;

/**
 * High-level data categories the user can toggle.
 * Each maps to one or more data types in the sync payload.
 */
export const SYNC_CATEGORIES = {
  fleet: {
    key: "fleet" as const,
    label: "Fleet & Pledges",
    description: "Ships, vehicles, insurance, skins, and pledge details",
    default: true,
  },
  buyback: {
    key: "buyback" as const,
    label: "Buy-Back Pledges",
    description: "Melted pledges available for reclaim",
    default: true,
  },
  upgrades: {
    key: "upgrades" as const,
    label: "Upgrade History",
    description: "CCU chains and applied upgrades per pledge",
    default: true,
  },
  account: {
    key: "account" as const,
    label: "Account Info",
    description: "Concierge level, subscriber status, org, balances",
    default: true,
  },
  shipNames: {
    key: "shipNames" as const,
    label: "Custom Ship Names",
    description: "Your named ships (e.g. Jean-Luc, James Holden)",
    default: true,
  },
} as const;

export type SyncCategoryKey = keyof typeof SYNC_CATEGORIES;
