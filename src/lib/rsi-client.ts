/**
 * RSI API client — makes authenticated requests to RSI on the user's behalf.
 *
 * Authentication uses the Rsi-Token cookie (read via browser.cookies API)
 * and the X-Rsi-XSRF header derived from it.
 */

import { RSI_BASE, RSI_REQUEST_DELAY_MS } from "./constants";

/** Cooldown: cache a "not logged in" result for 30s to avoid repeated checks */
const RSI_LOGIN_COOLDOWN_MS = 30_000;
let rsiLoginFalseUntil = 0;

/** Get the RSI authentication token from the browser cookie jar */
export async function getRsiToken(): Promise<string | null> {
  const cookie = await browser.cookies.get({
    url: RSI_BASE,
    name: "Rsi-Token",
  });
  return cookie?.value ?? null;
}

/** Check whether the user is currently logged into RSI */
export async function isRsiLoggedIn(): Promise<boolean> {
  // If we recently determined the user is not logged in, skip re-checking
  if (Date.now() < rsiLoginFalseUntil) {
    return false;
  }

  const token = await getRsiToken();
  if (token !== null) {
    // Logged in — clear any cooldown
    rsiLoginFalseUntil = 0;
    return true;
  }

  // Not logged in — cache for cooldown period
  rsiLoginFalseUntil = Date.now() + RSI_LOGIN_COOLDOWN_MS;
  return false;
}

/** Make an authenticated POST request to an RSI API endpoint */
export async function rsiPost<T = unknown>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const token = await getRsiToken();
  if (!token) {
    throw new Error("Not logged into RSI — Rsi-Token cookie not found");
  }

  const response = await fetch(`${RSI_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Rsi-Token": token,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`RSI API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/** Sleep for the configured delay between RSI requests */
export function rsiDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RSI_REQUEST_DELAY_MS));
}
