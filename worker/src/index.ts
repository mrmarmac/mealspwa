/**
 * Recipe-fetcher Worker.
 *
 * GET /?url=<encoded-page-url>
 *   -> { name, ingredientsRaw, method, imageUrl, sourceUrl }
 *
 * Stateless: no KV, no Durable Objects, no logging of the URLs it's asked
 * to fetch. It exists purely to do the one thing a browser can't do itself
 * (fetch an arbitrary third-party page without a CORS-friendly response) and
 * hand back structured data. See worker/README.md for deploy steps and the
 * honest limits of what this can actually parse (mostly recipe blogs — not
 * TikTok/Instagram).
 */

export interface FetchedRecipe {
  name: string;
  ingredientsRaw: string;
  method: string | null;
  imageUrl: string | null;
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// CORS — restricted to the Pages origin this app is actually deployed at,
// plus localhost for local dev. Never wildcarded: this endpoint fetches
// arbitrary third-party pages, and an open CORS policy would let any site
// use it as a free SSRF-protected proxy.
// ---------------------------------------------------------------------------

const ALLOWED_ORIGIN_EXACT = new Set(['https://mrmarmac.github.io']);
const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  return ALLOWED_ORIGIN_EXACT.has(origin) || ALLOWED_ORIGIN_PATTERN.test(origin);
}

function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errorResponse(status: number, error: string, origin: string | null): Response {
  // Deliberately never includes any upstream response body — only our own
  // short, fixed error strings.
  return jsonResponse({ error }, status, origin);
}

// ---------------------------------------------------------------------------
// SSRF guards
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isDisallowedIPv4(host: string): boolean {
  const match = IPV4_RE.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // "this" network
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) literals.
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host) || /^\[?fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (isDisallowedIPv4(host)) return true;
  return false;
}

interface ValidatedUrl {
  url: URL;
}

function validateTargetUrl(raw: string): ValidatedUrl | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'Malformed url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http/https urls are supported' };
  }
  if (isDisallowedHost(url.hostname)) {
    return { error: 'That host cannot be fetched' };
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return { error: 'Non-standard ports are not allowed' };
  }
  return { url };
}

// ---------------------------------------------------------------------------
// Bounded fetch: 8s timeout, 2MB read cap.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchPageBounded(url: URL): Promise<{ html: string } | { error: string; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!response.ok || !response.body) {
      return { error: 'Could not fetch that page', status: 502 };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytesRead = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BYTES) {
        // Stop reading — parse whatever we already have. Recipe JSON-LD is
        // almost always well within the first couple hundred KB.
        html += decoder.decode(value.subarray(0, Math.max(0, MAX_BYTES - (bytesRead - value.byteLength))));
        break;
      }
      html += decoder.decode(value, { stream: true });
    }
    void reader.cancel().catch(() => {});
    return { html };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { error: 'Timed out fetching that page', status: 504 };
    }
    return { error: 'Could not fetch that page', status: 502 };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// schema.org Recipe extraction (JSON-LD, then microdata, then OG fallback)
// ---------------------------------------------------------------------------

type JsonLike = Record<string, unknown>;

function isRecipeType(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase() === 'recipe';
  if (Array.isArray(value)) return value.some(isRecipeType);
  return false;
}

/** Walks a parsed JSON-LD document (which may be an object, an array of
 * objects, or an object with an `@graph`) looking for the first node whose
 * `@type` includes "Recipe". */
function findRecipeNode(doc: unknown): JsonLike | null {
  if (Array.isArray(doc)) {
    for (const entry of doc) {
      const found = findRecipeNode(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const obj = doc as JsonLike;
  if (isRecipeType(obj['@type'])) return obj;
  if (Array.isArray(obj['@graph'])) return findRecipeNode(obj['@graph']);
  return null;
}

function flattenInstructionEntry(entry: unknown): string[] {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(entry)) return entry.flatMap(flattenInstructionEntry);
  if (typeof entry === 'object' && entry !== null) {
    const obj = entry as JsonLike;
    // HowToSection: has itemListElement (nested steps) and a name/heading.
    if (Array.isArray(obj['itemListElement'])) {
      const heading = typeof obj['name'] === 'string' ? [`${obj['name']}:`] : [];
      return [...heading, ...flattenInstructionEntry(obj['itemListElement'])];
    }
    // HowToStep (or similar): has a text field.
    if (typeof obj['text'] === 'string') {
      const text = obj['text'].trim();
      return text ? [text] : [];
    }
  }
  return [];
}

function flattenInstructions(raw: unknown): string | null {
  const lines = flattenInstructionEntry(raw);
  return lines.length > 0 ? lines.join('\n') : null;
}

function extractIngredients(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .join('\n');
}

function extractImageUrl(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const url = extractImageUrl(entry);
      if (url) return url;
    }
    return null;
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as JsonLike;
    if (typeof obj['url'] === 'string') return obj['url'];
  }
  return null;
}

function extractFromJsonLd(html: string): Partial<FetchedRecipe> | null {
  const scriptRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html))) {
    const raw = match[1];
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeHtmlEntities(raw.trim()));
    } catch {
      continue;
    }
    const recipe = findRecipeNode(parsed);
    if (!recipe) continue;
    const name = typeof recipe['name'] === 'string' ? recipe['name'] : null;
    if (!name) continue;
    return {
      name,
      ingredientsRaw: extractIngredients(recipe['recipeIngredient']),
      method: flattenInstructions(recipe['recipeInstructions']),
      imageUrl: extractImageUrl(recipe['image']),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Microdata fallback (best-effort regex scan — Workers has no DOM parser)
// ---------------------------------------------------------------------------

function stripTags(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = re.exec(tag);
  return match?.[1] ?? null;
}

function extractMicrodataField(html: string, itemprop: string): string[] {
  // Matches `<tag itemprop="X" ...>content</tag>` (non-nested, best effort)
  // as well as self-closing `content`/`src`-bearing tags like <meta>/<img>.
  const re = new RegExp(
    `<([a-z0-9]+)((?:(?!>)[\\s\\S])*?\\bitemprop\\s*=\\s*["']${itemprop}["'][\\s\\S]*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1>)`,
    'gi',
  );
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const attrs = match[2] ?? '';
    const inner = match[3];
    const content = extractAttr(attrs, 'content') ?? extractAttr(attrs, 'src');
    if (content) {
      results.push(decodeHtmlEntities(content));
    } else if (inner) {
      const text = stripTags(inner);
      if (text) results.push(text);
    }
  }
  return results;
}

function extractFromMicrodata(html: string): Partial<FetchedRecipe> | null {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/Recipe["']/i.test(html)) return null;
  const names = extractMicrodataField(html, 'name');
  const name = names[0];
  if (!name) return null;
  const ingredients = extractMicrodataField(html, 'recipeIngredient');
  const instructions = extractMicrodataField(html, 'recipeInstructions');
  const images = extractMicrodataField(html, 'image');
  return {
    name,
    ingredientsRaw: ingredients.join('\n'),
    method: instructions.length > 0 ? instructions.join('\n') : null,
    imageUrl: images[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// og: fallback — name + photo only, per the parsing contract.
// ---------------------------------------------------------------------------

function extractOgFallback(html: string): Partial<FetchedRecipe> | null {
  const titleMatch =
    /<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i.exec(html);
  const imageMatch =
    /<meta[^>]+property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:image["']/i.exec(html);
  const name = titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]) : null;
  if (!name) return null;
  return {
    name,
    ingredientsRaw: '',
    method: null,
    imageUrl: imageMatch?.[1] ? decodeHtmlEntities(imageMatch[1]) : null,
  };
}

function extractRecipe(html: string, sourceUrl: string): FetchedRecipe | null {
  const found = extractFromJsonLd(html) ?? extractFromMicrodata(html) ?? extractOgFallback(html);
  if (!found?.name) return null;
  return {
    name: found.name,
    ingredientsRaw: found.ingredientsRaw ?? '',
    method: found.method ?? null,
    imageUrl: found.imageUrl ?? null,
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return errorResponse(405, 'Only GET is supported', origin);
    }

    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get('url');
    if (!target) {
      return errorResponse(400, 'Missing "url" query parameter', origin);
    }

    const validated = validateTargetUrl(target);
    if ('error' in validated) {
      return errorResponse(400, validated.error, origin);
    }

    const fetched = await fetchPageBounded(validated.url);
    if ('error' in fetched) {
      return errorResponse(fetched.status, fetched.error, origin);
    }

    const recipe = extractRecipe(fetched.html, validated.url.toString());
    if (!recipe) {
      return errorResponse(422, 'No recipe found on that page', origin);
    }

    return jsonResponse(recipe, 200, origin);
  },
};
