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
  /** List buy-back pledges (paginated) */
  buybackPledges: "/api/account/buyBackPledges",
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
