/** Types for RSI data and sync payloads */

// ── Pledge Data (scraped from RSI HTML) ──

/** A pledge container parsed from RSI's hangar page */
export interface RsiPledge {
  id: number;
  name: string;
  /** Display value e.g. "$220.00 USD" or "¤5,000 UEC" */
  value: string;
  /** Parsed USD value (0 for non-USD pledges) */
  valueCents: number;
  /** Original pre-upgrade value e.g. "$0.00 USD" */
  configurationValue: string;
  /** Currency label: "Store Credit", "UEC", "TyCustomer_ledger_-en" */
  currency: string;
  /** Human-readable date e.g. "February 22, 2018" */
  date: string;
  isUpgraded: boolean;
  isReclaimable: boolean;
  isGiftable: boolean;
  /** Whether an upgrade log exists for this pledge */
  hasUpgradeLog: boolean;
  availability: string;
  items: RsiPledgeItem[];
  /** Ships that can be named within this pledge */
  nameableShips: NamedShip[] | null;
  /** Map of membership_id → custom name */
  nameReservations: Record<string, string> | null;
  /** CCU from/to data (upgrade pledges only) */
  upgradeData: RsiUpgradeData | null;
  /** Pledge-level thumbnail image (from the row's background-image) */
  pledgeImage: string | null;
  // Derived fields
  hasLti: boolean;
  isWarbond: boolean;
  isReward: boolean;
}

/** An item within an RSI pledge */
export interface RsiPledgeItem {
  title: string;
  kind: string | null;
  manufacturer?: string;
  manufacturerCode?: string;
  image?: string;
  customName?: string;
  serial?: string;
  /** Whether the item slot is nameable */
  isNameable?: boolean;
}

/** CCU/upgrade data embedded in upgrade pledges */
export interface RsiUpgradeData {
  id: number;
  name: string;
  upgrade_type: string;
  upgrade_value: string | null;
  match_items: Array<{ id: number; name: string }>;
  target_items: Array<{ id: number; name: string }>;
}

/** A buy-back pledge — melted and available for reclaim */
export interface RsiBuyBackPledge {
  id: number;
  name: string;
  value: string;
  value_cents?: number;
  date: string;
  date_parsed?: string;
  items: RsiPledgeItem[];
  /** Whether it can be reclaimed with store credit */
  is_credit_reclaimable: boolean;
  /** Token cost if applicable */
  token_cost?: number;
}

/** A CCU/upgrade entry from RSI's /api/account/upgradeLog */
export interface RsiUpgrade {
  pledge_id: number;
  name: string;
  applied_at: string;
  new_value: string;
}

/** A custom-named ship */
export interface NamedShip {
  membership_id: number;
  default_name: string;
  custom_name: string;
}

// ── Account Data ──

/** Account metadata from RSI */
export interface RsiAccountInfo {
  nickname: string;
  displayname: string;
  avatar_url?: string;
  enlisted_since?: string;
  country?: string;
  concierge_level?: string;
  concierge_next_level?: string;
  concierge_progress?: number;
  subscriber_type?: string;
  subscriber_frequency?: string;
  /** Balances parsed from creditsData array */
  store_credit_cents?: number;
  uec_balance?: number;
  rec_balance?: number;
  /** Primary org from dashboard */
  org?: RsiOrgInfo;
  /** All orgs from /api/account/getOrgInfo */
  orgs?: RsiOrgInfo[];
  /** Featured/chosen badges displayed on profile */
  featured_badges?: RsiBadgeDisplay[];
  /** All earned badges (id → name) from /api/account/badge/getBadges */
  all_badges?: Record<string, string>;
  referral_code?: string;
  has_game_package?: boolean;
  is_subscriber?: boolean;
  email?: string;
}

/** An RSI org membership */
export interface RsiOrgInfo {
  name: string;
  sid: string;
  image?: string;
  url?: string;
  rank?: string;
  is_primary?: boolean;
  members?: string;
}

/** A badge displayed on the user's profile */
export interface RsiBadgeDisplay {
  title: string;
  image_url: string;
  org_url?: string;
}

// ── Sync Payload ──

/** The full sync payload sent to SC Bridge API */
export interface SyncPayload {
  pledges: RsiPledge[];
  buyback_pledges: RsiBuyBackPledge[];
  upgrades: RsiUpgrade[];
  account: RsiAccountInfo | null;
  named_ships: NamedShip[];
  sync_meta: {
    extension_version: string;
    synced_at: string;
    pledge_count: number;
    buyback_count: number;
    ship_count: number;
    item_count: number;
  };
}

// ── Extension Messages ──

/** Messages between content script / popup ↔ background service worker */
export type ExtensionMessage =
  | { type: "GET_STATUS" }
  | { type: "GET_RSI_TOKEN" }
  | { type: "LOGIN"; token: string }
  | { type: "LOGOUT" }
  | {
      type: "STATUS";
      rsiLoggedIn: boolean;
      scBridgeLoggedIn: boolean;
      consentGiven: boolean;
      syncing: boolean;
      lastSync: string | null;
      error: string | null;
    }
  | { type: "GET_LAST_PAYLOAD" }
  | { type: "LAST_PAYLOAD"; payload: SyncPayload | null }
  | { type: "BRIDGE_COLLECT_HANGAR" }
  | { type: "COLLECT_ALL_DATA" }
  | { type: "COLLECT_RESULT"; payload: SyncPayload }
  | { type: "COLLECT_ERROR"; error: string }
  | { type: "SYNC_SPECTRUM_FRIENDS" }
  | { type: "SPECTRUM_FRIENDS_RESULT"; count: number; selfHandle: string }
  | { type: "SPECTRUM_FRIENDS_ERROR"; error: string };
