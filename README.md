# Meals

A small installable web app for a couple to capture recipes, plan a week of
lunch/dinner slots, and shop from one merged list — designed to be used
one-handed, in a supermarket aisle, with no signal.

## The three-part flow

1. **Capture** — paste ingredients/method from wherever a recipe came from
   (a screenshot caption, a blog, a share-sheet share), or point it at a URL
   and let the optional [recipe-fetcher worker](worker/README.md) try to
   pull the structured recipe for you. Paste is the reliable path; URL
   fetching only really works on recipe blogs (see the worker's README for
   why).
2. **Plan** — drop recipes onto a lunch/dinner board for the week. This is
   the screen the app opens to (`start_url` and the default route both point
   here) — it's the one you actually check day to day, not the recipe
   library.
3. **Shop** — generate one merged shopping list across everything planned,
   grouped by aisle in the order you actually walk the store, with
   quantities combined across recipes and days.

## Running locally

```sh
npm install
npm run dev
```

Optional: point paste-free URL import at a deployed fetcher worker by
creating `.env.local`:

```
VITE_RECIPE_FETCHER_URL=https://meals-recipe-fetcher.<your-subdomain>.workers.dev
```

Without it, URL import is simply unavailable and the app falls back to
paste — nothing breaks.

```sh
npm run typecheck   # tsc -b --noEmit
npm test            # vitest run
npm run build        # tsc -b && vite build -> dist/
npm run preview      # serve the production build locally
```

## Deploying (GitHub Pages)

Deploys are automatic on every push to `main` via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): typecheck,
test, build, then publish `dist/` to Pages. A failing test or typecheck
blocks the deploy.

**One-time setup**, before the first deploy will actually publish anything:

1. Repo → **Settings → Pages → Source: GitHub Actions** (not "Deploy from a
   branch" — this repo doesn't commit a `gh-pages` branch).
2. If you're using the optional recipe-fetcher worker, also set the
   `VITE_RECIPE_FETCHER_URL` repository variable — see
   [`worker/README.md`](worker/README.md) for the exact steps.
3. Push to `main` (or run the workflow manually via **Actions → Deploy to
   GitHub Pages → Run workflow**).

The app is hosted at `https://mrmarmac.github.io/mealspwa/`. `vite.config.ts`
sets `base: '/mealspwa/'` to match — if you fork this under a different repo
name, update `base` there (and the hard-coded worker CORS origin in
`worker/src/index.ts`) to match.

### Troubleshooting: "Branch main is not allowed to deploy to github-pages"

If the `deploy` job fails with

> Branch "main" is not allowed to deploy to github-pages due to environment
> protection rules.

then the setup above isn't finished — this is a **repository Settings**
issue, not a workflow bug (nothing in `deploy.yml` can override an
environment protection rule). The `github-pages` environment is rejecting a
deploy from `main`. Fix it in one of two places:

1. **Settings → Pages → Source** must be **GitHub Actions**, not "Deploy from
   a branch". In "Deploy from a branch" mode GitHub pins the `github-pages`
   environment to that single branch and rejects the Actions-based deploy
   from `main`. This is the usual cause (it's one-time setup step 1 above).
2. If it's already "GitHub Actions", check **Settings → Environments →
   `github-pages` → Deployment branches and tags**. Set it to "No
   restriction", or add a rule that matches `main` (a "Selected branches" or
   "Protected branches only" policy that doesn't match `main` produces this
   exact error).

After changing the setting, re-run via **Actions → Deploy to GitHub Pages →
Run workflow**.

### Why hash routing

The app uses `HashRouter` (see the comment in `src/App.tsx`). GitHub Pages
serves static files with no server-side rewrite rules, so a normal path
route like `/mealspwa/recipes/abc` 404s on a hard refresh or deep link —
there's nothing on the server to route it back to `index.html`. Hash routes
(`#/recipes/abc`) never leave `index.html` as far as the server is
concerned, so deep links, the installed app's `start_url` (`#/plan`), and
offline navigation all just work, with zero server configuration.

## The optional recipe-fetcher worker

`worker/` is a small, separately-deployed Cloudflare Worker that fetches a
recipe URL server-side and extracts structured data from it. It's entirely
optional — the app works without it, just without URL import. See
[`worker/README.md`](worker/README.md) for deploy steps and, importantly,
its actual limits: it works for recipe blogs and **not at all** for TikTok
or Instagram.

## Limitations (read this before relying on it)

This is a v1, and it is honestly **local-only**:

- **Data lives in one browser, on one device.** Everything — recipes, the
  plan, shopping ticks — is stored locally (IndexedDB) in whichever browser
  you're using. There is no server, no account, and nothing syncs anywhere
  on its own.
- **Two-person sync is not implemented yet.** The domain model (see
  `src/domain/types.ts`) is already designed around eventual multi-device
  sync — every record carries the sync envelope fields (`updatedAt` as an
  HLC, `lastWriterClientId`, tombstones instead of hard deletes) — but the
  actual sync transport doesn't exist yet. If two people both use the app
  right now, they're each working on their own independent copy.
- **The manual handoff, for now, is space export/import** (whenever that
  screen ships) — one person exports their space, the other imports it, and
  from that point they're two independent copies again until the next
  manual handoff. This is a real limitation, not a rounding error: don't
  plan a shared week across two phones and expect it to reconcile itself.
