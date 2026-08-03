/**
 * Client for the recipe-fetcher Cloudflare Worker (see worker/). This module
 * NEVER throws: a broken or absent worker must degrade to "paste the
 * ingredients yourself", not break the import screen.
 */

export interface FetchedRecipe {
  name: string;
  ingredientsRaw: string;
  method: string | null;
  imageUrl: string | null;
  sourceUrl: string;
}

const TIMEOUT_MS = 6000;

function isFetchedRecipe(value: unknown): value is FetchedRecipe {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string' &&
    typeof v['ingredientsRaw'] === 'string' &&
    (typeof v['method'] === 'string' || v['method'] === null) &&
    (typeof v['imageUrl'] === 'string' || v['imageUrl'] === null) &&
    typeof v['sourceUrl'] === 'string'
  );
}

/**
 * Asks the recipe-fetcher worker to scrape `url`. Returns `null` — never
 * throws — when:
 *  - `VITE_RECIPE_FETCHER_URL` isn't configured for this build,
 *  - the request errors (network down, CORS, worker 4xx/5xx),
 *  - it doesn't complete within 6s,
 *  - or the response isn't shaped like a `FetchedRecipe`.
 * Callers should fall back to the paste flow on `null`.
 */
export async function fetchRecipeFromUrl(url: string): Promise<FetchedRecipe | null> {
  const endpoint = import.meta.env.VITE_RECIPE_FETCHER_URL as string | undefined;
  if (!endpoint) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const requestUrl = `${endpoint}${endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
    const response = await fetch(requestUrl, { signal: controller.signal });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (!isFetchedRecipe(data)) return null;
    return data;
  } catch {
    // Network error, abort/timeout, CORS failure, bad JSON — all treated
    // the same: fall back to paste.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
