/** Check if user has an active SC Bridge session (via cookies) */
export async function isScBridgeLoggedIn(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/api/auth/get-session`, {
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { session?: unknown };
    return !!data?.session;
  } catch {
    return false;
  }
}
