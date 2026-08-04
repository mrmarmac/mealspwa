# Meals sync worker

A small Cloudflare Worker + D1 database that lets two devices in one household
share a space. It is the backend for the app's already-built sync layer: the
hybrid logical clock, per-entity last-write-wins (`resolve()`), tombstones and
outbox all live in the app; this worker only stores the latest-by-HLC row per
entity and serves deltas.

**This is a separate worker from `worker/`** (the recipe fetcher). That one is
deliberately stateless; anything that needs storage lives here instead.

## What it does

```
POST /push   { spaceId, entities: Syncable[] }   Authorization: Bearer <token>
  -> { acceptedIds: string[] }

GET  /pull?spaceId=<id>&since=<hlc>              Authorization: Bearer <token>
  -> { spaceId, since, entities: Syncable[] }
```

- **Dumb by design.** The server never generates or re-stamps HLC timestamps —
  clients own the clock, and a client rejects an implausibly-future remote HLC.
  The per-row upsert keeps only the newest version by HLC (a plain string
  compare), which is the same last-write-wins the client runs on pull.
- **Per-space capability token.** The first push for a new space binds a token
  (trust-on-first-use); every later request must present it. The server stores
  only `sha256(token)` — never the token itself. CORS is restricted to the
  deployed Pages origin plus localhost, and error bodies are fixed short
  strings that never leak storage internals.
- Recipe photos (blobs) are not synced — same as the manual export, they're
  content-addressed and re-attached per device.

## Deploying

You need a (free) Cloudflare account. From this directory:

```sh
npm install

# 1. Create the D1 database (one time). Copy the printed database_id into
#    wrangler.toml's [[d1_databases]] block, replacing the placeholder.
npx wrangler d1 create meals-sync

# 2. Apply the schema (one time, and again whenever migrations/ changes).
npx wrangler d1 migrations apply meals-sync --remote

# 3. Deploy.
npx wrangler deploy
```

The first run prompts you to log in (`wrangler login`). Deploy output ends with
a line like:

```
Published meals-sync
  https://meals-sync.<your-subdomain>.workers.dev
```

That URL is what you set as `VITE_SYNC_URL`.

To redeploy after a code change, just `npx wrangler deploy` again.

## Wiring it into the app

Same pattern as the recipe fetcher (`VITE_RECIPE_FETCHER_URL`).

**Locally**, add to `.env.local` at the repo root (gitignored) and restart
`npm run dev`:

```
VITE_SYNC_URL=https://meals-sync.<your-subdomain>.workers.dev
```

**In GitHub Actions**, set it as a repository **variable** (not a secret — it's
a public URL; the per-space token is the credential and lives on-device, never
in the build):

1. Repo → Settings → Secrets and variables → Actions → **Variables** tab
2. New repository variable: `VITE_SYNC_URL` =
   `https://meals-sync.<your-subdomain>.workers.dev`

`.github/workflows/deploy.yml` already reads `${{ vars.VITE_SYNC_URL }}` into
the build step. If the variable is unset, the app simply stays local-only — the
"Sync across devices" controls in Settings don't appear.

Once deployed and wired, on device 1: **Settings → Sync across devices → Enable
sync**, then copy the join code. On device 2: **Join a space**, paste the code.

## Local dev

```sh
# Local D1 + worker at http://localhost:8787
npx wrangler d1 migrations apply meals-sync --local
npx wrangler dev
```

Point `VITE_SYNC_URL=http://localhost:8787` in `.env.local` to test against it
without deploying.

## Tests

```sh
npm test        # vitest: the pure LWW / auth / parsing logic in src/store.ts
```

The full request round-trip (two devices converging through the server) is
covered by `src/sync/sync-roundtrip.test.ts` in the root package, which mirrors
this worker's push/pull/LWW/auth contract against an in-memory fake server.

## Threat model (be honest about this)

- The `(spaceId, token)` pair is a bearer capability: anyone holding both can
  read and write the space. `spaceId` is a UUID (not guessable) and the token
  is 128-bit, sent over HTTPS — adequate for a two-person household, not a
  multi-tenant SaaS.
- First-push binding means an attacker would have to bind a real space's id
  *before its owner's first push*, which needs the unguessable id up front.
- No token rotation/revocation, no rate limiting in v1. Disconnecting and
  re-enabling mints a new token but does not rebind the server's existing
  space row — a proper rotate endpoint is future work.
