# Meals recipe-fetcher worker

A tiny, stateless Cloudflare Worker that fetches a recipe page server-side
(so the browser doesn't hit CORS) and extracts a structured recipe from it —
schema.org JSON-LD first, then microdata, then an `og:title`/`og:image`
fallback for just the name and photo.

**Be honest with yourself about what this does and doesn't do**: it works
well for recipe blogs (the ones that bother with schema.org markup, which is
most of them, because it's an SEO win for them). It does **not** work at all
for TikTok or Instagram — neither publishes structured recipe data, and a
worker fetching those pages server-side gets a JS-rendered shell, not a
recipe. Since a lot of this app's actual recipe library probably comes from
TikTok/Instagram screenshots and captions, **paste remains the primary way
recipes get into this app** — this worker is a convenience for the blogs,
not the main path.

## What it does

```
GET /?url=<url-encoded page url>
```

returns

```json
{
  "name": "...",
  "ingredientsRaw": "...\n...",
  "method": "...\n...",
  "imageUrl": "https://...",
  "sourceUrl": "https://..."
}
```

or a structured error: `{ "error": "..." }` with a 4xx/5xx status.

It never stores anything, never logs the URLs it's asked to fetch, and
rejects requests aimed at private/loopback/link-local hosts or non-standard
ports before making any outbound fetch (basic SSRF hardening — see
`src/index.ts` for specifics). The outbound fetch is capped at 8 seconds and
2 MB read. CORS is restricted to the deployed Pages origin
(`https://mrmarmac.github.io`) plus localhost, so this can't be used as an
open proxy from arbitrary sites.

## Deploying

You need a (free) Cloudflare account. From this directory:

```sh
npx wrangler deploy
```

The first run will prompt you to log in (`wrangler login`) and will create
the worker under the name in `wrangler.toml` (`meals-recipe-fetcher`).
Deploy output ends with a line like:

```
Published meals-recipe-fetcher
  https://meals-recipe-fetcher.<your-subdomain>.workers.dev
```

That URL is what you set as `VITE_RECIPE_FETCHER_URL`.

To redeploy after a change, just run `npx wrangler deploy` again — it's the
same command every time, there's no separate "first deploy" step beyond the
login prompt.

## Wiring it into the app

**Locally**, create a `.env.local` file at the repo root (already
gitignored):

```
VITE_RECIPE_FETCHER_URL=https://meals-recipe-fetcher.<your-subdomain>.workers.dev
```

Restart `npm run dev` after adding it — Vite only reads `.env*` files at
startup.

**In GitHub Actions**, set it as a repository (or environment) *variable*
(not a secret — it's a public URL with no credentials in it) so the deploy
workflow can pass it to the build:

1. Repo → Settings → Secrets and variables → Actions → **Variables** tab
2. New repository variable: `VITE_RECIPE_FETCHER_URL` =
   `https://meals-recipe-fetcher.<your-subdomain>.workers.dev`

`.github/workflows/deploy.yml` already reads
`${{ vars.VITE_RECIPE_FETCHER_URL }}` into the build step — nothing else to
change there. If the variable is unset, the build still succeeds:
`src/lib/fetcher.ts` treats a missing endpoint as "no worker configured" and
the import screen falls back to paste.

## Local dev

```sh
npx wrangler dev
```

prints a local URL you can point `VITE_RECIPE_FETCHER_URL` at in
`.env.local` for testing without deploying.
