/**
 * Spectrum friends sync — fetches friends list from RSI Spectrum.
 *
 * Calls /api/spectrum/auth/identify which returns the user's friends
 * with presence status. No content script needed — uses the same
 * Rsi-Token cookie as other RSI API calls.
 */

import { rsiPost } from "./rsi-client";
import { RSI_API } from "./constants";

/** Presence info from Spectrum */
interface SpectrumPresence {
  status: "online" | "away" | "offline" | "dnd";
  info: string | null;
  since: string | null;
}

/** A friend from the Spectrum identify response */
interface SpectrumFriend {
  id: string;
  displayname: string;
  nickname: string;
  avatar: string | null;
  presence: SpectrumPresence;
  isGM: boolean;
  spoken_languages: string[];
  meta: {
    badges?: Array<{ name: string; icon: string; url?: string }>;
  };
}

/** The identify response shape (only the fields we use) */
interface SpectrumIdentifyResponse {
  success: number;
  data: {
    member: {
      id: string;
      nickname: string;
      displayname: string;
    };
    friends: SpectrumFriend[];
  };
}

/** Friend data mapped to the SC Bridge companion sync schema */
export interface MappedFriend {
  account_id: string;
  nickname: string;
  display_name: string;
  presence: string;
  activity_detail: string;
}

/**
 * Fetch friends from Spectrum and map to the SC Bridge schema.
 *
 * Returns the mapped friends array ready for POST to /api/companion/sync/friends.
 */
export async function fetchSpectrumFriends(): Promise<{
  friends: MappedFriend[];
  selfHandle: string;
}> {
  const response = await rsiPost<SpectrumIdentifyResponse>(
    RSI_API.spectrumIdentify,
  );

  if (!response.success || !response.data?.friends) {
    throw new Error("Spectrum identify failed — no friends data in response");
  }

  const friends: MappedFriend[] = response.data.friends.map((f) => ({
    account_id: String(f.id),
    nickname: f.nickname || "",
    display_name: f.displayname || "",
    presence: f.presence?.status || "offline",
    activity_detail: f.presence?.info || "",
  }));

  return {
    friends,
    selfHandle: response.data.member?.nickname || "",
  };
}
