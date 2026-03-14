/** Types for RSI API responses and sync payloads */

/** A pledge container from RSI's /api/account/pledges */
export interface RsiPledge {
  id: number;
  name: string;
  value: string;
  configuration_value: string;
  date: string;
  is_upgraded: boolean;
  is_reclaimable: boolean;
  is_giftable: boolean;
  availability: string;
  items: RsiPledgeItem[];
}

/** An item within an RSI pledge */
export interface RsiPledgeItem {
  title: string;
  kind: string;
  manufacturer_code?: string;
  manufacturer_name?: string;
  image?: string;
  custom_name?: string;
  serial?: string;
  is_nameable?: boolean;
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
  store_credit_cents?: number;
  uec_balance?: number;
  rec_balance?: number;
  org_name?: string;
  org_sid?: string;
  badges?: Record<string, string>;
  referral_code?: string;
  has_game_package?: boolean;
}

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

/** A custom-named ship */
export interface NamedShip {
  membership_id: number;
  default_name: string;
  custom_name: string;
}

/** Messages between popup ↔ background service worker */
export type ExtensionMessage =
  | { type: "GET_STATUS" }
  | { type: "START_SYNC" }
  | { type: "CANCEL_SYNC" }
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
  | { type: "SYNC_PROGRESS"; phase: string; detail: string; percent: number }
  | { type: "SYNC_COMPLETE"; timestamp: string }
  | { type: "SYNC_ERROR"; error: string }
  | { type: "GET_LAST_PAYLOAD" }
  | { type: "LAST_PAYLOAD"; payload: SyncPayload | null }
  | { type: "FETCH_ALL_PLEDGE_VALUES" }
  | { type: "ALL_PLEDGE_VALUES"; totalSpend: number; pledgeCount: number };
