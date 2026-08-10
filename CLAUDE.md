# CLAUDE.md

Orientation for Claude Code sessions in this repo. Read this first — it exists so you
don't have to re-derive the architecture and conventions every session.

## What this is

**Meals** — an installable, offline-first PWA for a two-person household to capture
recipes, plan a week of lunch/dinner slots, and shop from one merged, aisle-ordered
list. Designed to be used one-handed, in a supermarket, with no signal. Deployed to
GitHub Pages from `main` via `.github/workflows/deploy.yml` (typecheck → test → build →
publish `dist/`).

Stack: React 18 + TypeScript + Vite + Zustand + IndexedDB (`idb`) +
`react-router-dom` **v7** (HashRouter). Tests: Vitest + fake-indexeddb.

## Commands

- `npm run dev` — Vite dev server.
- `npm run typecheck` — `tsc -b --noEmit`. **This is the lint gate** (no ESLint in this repo).
- `npm test` — Vitest run (currently ~193 tests). `npm run test:watch` for watch mode.
- `npm run build` — `tsc -b && vite build` → `dist/`.
- `npm run preview` — serve the production build. Served under base `/mealspwa/` with
  hash routes, e.g. `http://localhost:4173/mealspwa/#/plan`.
- `npm run seed` — seed recipes from CSV (`scripts/seed-from-csv.ts`).

Before pushing, run `npm run typecheck && npm test && npm run build` — the deploy
workflow gates on all three.

## Layout

- `src/screens/` — one file per screen (Plan, Recipes, RecipeDetail, Capture, Import,
  Shop, Settings), each with a colocated `.css`. Lazy-loaded in `src/App.tsx`.
- `src/shell/` — app chrome + shared UI (AppShell, BottomSheet, Toast, Icon,
  LongPressMenu, ErrorBoundary, Spinner, QrCode, QrScanner).
- `src/store/` — Zustand stores (space, recipe, plan, shopping, sync).
- `src/domain/` — the data model. **`types.ts` is the contract every layer imports;
  treat changes to it as breaking across the whole app.** Also HLC clock, plan window.
- `src/sync/` — CRDT-style sync: HLC clocks, last-writer-wins, tombstones, outbox,
  remote adapter, space export/import, join-code codec.
- `src/parser/` — heuristic, confidence-scored ingredient parser + lexicons (JSON).
- `src/merge/`, `src/shopping/` — quantity merging and shopping-list derivation.
- `worker/` — optional Cloudflare Worker that fetches structured recipes from a URL.
- `sync-worker/` — optional Cloudflare Worker sync backend.

## Load-bearing conventions (understand before changing)

- **Features degrade to no-op when their env var is unset.** No `VITE_SYNC_URL` → the
  app is local-only and nothing throws. No `VITE_RECIPE_FETCHER_URL` → URL import is
  simply unavailable, paste still works. Preserve this "unconfigured = invisible, not
  broken" contract when touching sync or import.
- **`HashRouter` is required**, not a preference — GitHub Pages has no server-side
  rewrites, so history routes would 404 on deep links / offline launch.
- **Service worker uses `registerType: 'prompt'`** on purpose — it must never
  force-reload mid-shop. Updates are offered via a toast (see `src/App.tsx`).
- **Sync conflict resolution reads only `updatedAt` (an HLC).** Deletes are ordinary
  writes with a tombstone (`deletedAt`), not a special case.
- Recipe tags are a **deliberately closed vocabulary** (`RECIPE_TAGS` in `types.ts`).
- The plan board is **tap-to-place, not drag-and-drop** — intentional (accessible,
  one-handed).

### Do NOT "fix" these (settled decisions)

Drag-and-drop for the plan board; opening up the closed tag vocabulary; switching off
HashRouter; changing the SW away from `registerType: 'prompt'`. If you think one should
change, raise it with the user first rather than just doing it.

## Git workflow

Develop on a fresh branch off latest `main`; commit with clear messages; push with
`git push -u origin <branch>`; open a **ready-for-review** PR (no PR template in this
repo). If a branch's PR is already merged, start fresh from `main` — don't stack on
merged history.

## Known follow-ups (as of this file's writing)

- **No e2e tests yet.** Adding a Playwright smoke suite (capture→plan→shop, offline
  reload, SW update prompt) is the highest-value next test investment. Playwright's
  Chromium is preinstalled in the web environment under `/opt/pw-browsers/`.
- **Dependabot alerts are dev-only.** Runtime is clean (`npm audit --omit=dev` = 0);
  the alerts are in the vite/vitest/esbuild toolchain (root) and `wrangler` transitives
  (`sync-worker/`). Fixing the root set needs `vitest@4` (breaking major); fix on a
  branch and re-run the suite.
