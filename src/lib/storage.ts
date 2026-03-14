/**
 * Extension storage helpers — wraps browser.storage.local with typed keys.
 *
 * Service workers can be terminated at any time, so all state must be
 * persisted here rather than held in memory.
 */

import { STORAGE_KEYS, SYNC_CATEGORIES, type SyncCategoryKey } from "./constants";

/** Get whether the user has given consent for data sync */
export async function hasConsent(): Promise<boolean> {
  const result = await browser.storage.local.get(STORAGE_KEYS.consentGiven);
  return result[STORAGE_KEYS.consentGiven] === true;
}

/** Record that the user has given consent */
export async function setConsent(value: boolean): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.consentGiven]: value });
}

/** Get the SC Bridge auth token */
export async function getAuthToken(): Promise<string | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.authToken);
  return (result[STORAGE_KEYS.authToken] as string) ?? null;
}

/** Store the SC Bridge auth token */
export async function setAuthToken(token: string): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.authToken]: token });
}

/** Clear the SC Bridge auth token */
export async function clearAuthToken(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.authToken);
}

/** Get the last sync timestamp */
export async function getLastSync(): Promise<string | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.lastSync);
  return (result[STORAGE_KEYS.lastSync] as string) ?? null;
}

/** Record a successful sync */
export async function setLastSync(iso: string): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.lastSync]: iso });
}

/** Get the in-progress sync checkpoint (for resuming after service worker restart) */
export async function getSyncCheckpoint(): Promise<SyncCheckpoint | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.syncCheckpoint);
  return (result[STORAGE_KEYS.syncCheckpoint] as SyncCheckpoint) ?? null;
}

/** Save a sync checkpoint */
export async function setSyncCheckpoint(
  checkpoint: SyncCheckpoint,
): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.syncCheckpoint]: checkpoint,
  });
}

/** Clear the sync checkpoint (sync complete or cancelled) */
export async function clearSyncCheckpoint(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.syncCheckpoint);
}

// ── Sync Preferences ──

/** Which data categories the user wants to sync */
export type SyncPreferences = Record<SyncCategoryKey, boolean>;

/** Get sync preferences, falling back to defaults */
export async function getSyncPreferences(): Promise<SyncPreferences> {
  const result = await browser.storage.local.get(STORAGE_KEYS.syncPreferences);
  const stored = result[STORAGE_KEYS.syncPreferences] as
    | Partial<SyncPreferences>
    | undefined;

  const defaults: SyncPreferences = {} as SyncPreferences;
  for (const [key, cat] of Object.entries(SYNC_CATEGORIES)) {
    defaults[key as SyncCategoryKey] = stored?.[key as SyncCategoryKey] ?? cat.default;
  }
  return defaults;
}

/** Save sync preferences */
export async function setSyncPreferences(
  prefs: SyncPreferences,
): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.syncPreferences]: prefs });
}

/** Check if a specific category is enabled */
export async function isCategoryEnabled(
  key: SyncCategoryKey,
): Promise<boolean> {
  const prefs = await getSyncPreferences();
  return prefs[key];
}

/** Checkpoint for resumable sync */
export interface SyncCheckpoint {
  /** Which phase: pledges, buyback, upgrades, account */
  phase: "pledges" | "buyback" | "upgrades" | "account" | "upload";
  /** Current page (for paginated pledge fetching) */
  page?: number;
  /** Pledges collected so far */
  pledgesCollected?: number;
  /** Timestamp when this checkpoint was saved */
  savedAt: string;
}
