import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// Brand colours — keep in sync with src/styles/tokens.css (--color-primary /
// --color-bg). Duplicated here because the manifest is generated at build
// time and can't read CSS custom properties.
const THEME_COLOR = '#D6603A';
const BACKGROUND_COLOR = '#FBF8F5';

// GitHub Pages serves this app from https://mrmarmac.github.io/mealspwa/ —
// every absolute path (base, scope, start_url, icon src) must include this
// subpath, or assets 404 the moment the app leaves local dev.
const BASE = '/mealspwa/';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Origin of the recipe-fetcher Worker (see worker/), so the runtime cache
  // rule below only intercepts requests actually going to it. Unset in an
  // environment that doesn't configure the worker — the pattern below then
  // never matches, and the app runs with no worker caching at all.
  //
  // IMPORTANT: this has to be a RegExp, not a `({url}) => ...` predicate
  // function that closes over `fetcherOrigin`. Workbox's `generateSW` mode
  // embeds function-typed urlPatterns into the built service worker via
  // `Function.prototype.toString()` — it copies the function's *source
  // text* verbatim, not its closure. A reference to `fetcherOrigin` would
  // compile fine here (it's a real variable in vite.config.ts) but then
  // throw `ReferenceError: fetcherOrigin is not defined` inside the actual
  // service worker, which has no idea what that name is. A RegExp has no
  // such problem: its `.toString()` is a self-contained literal.
  const fetcherOrigin = (() => {
    try {
      return env.VITE_RECIPE_FETCHER_URL ? new URL(env.VITE_RECIPE_FETCHER_URL).origin : null;
    } catch {
      return null;
    }
  })();
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Matches nothing when unset — /(?!)/ never matches any string.
  const fetcherOriginPattern = fetcherOrigin ? new RegExp(`^${escapeRegExp(fetcherOrigin)}/`) : /(?!)/;

  return {
  base: BASE,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): a service worker swap mid-session forces
      // a reload, and an unannounced reload while someone is mid-shop with a
      // half-ticked list is actively hostile. We ask instead — see the
      // update toast wired up in src/App.tsx via useRegisterSW.
      registerType: 'prompt',
      includeAssets: [
        'favicon.svg',
        'apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-192.png',
        'icons/icon-maskable-512.png',
      ],
      manifest: {
        name: 'Meals',
        short_name: 'Meals',
        description: 'Capture recipes, plan the week, shop from one merged list.',
        // Hash route so a cold, offline launch from the home screen lands
        // straight on the board you actually check in the shop — see the
        // HashRouter note in src/main.tsx for why hash routing is load-bearing
        // on GitHub Pages generally, not just here.
        start_url: `${BASE}#/plan`,
        scope: BASE,
        id: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: BACKGROUND_COLOR,
        theme_color: THEME_COLOR,
        lang: 'en',
        icons: [
          {
            src: `${BASE}icons/icon-192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: `${BASE}icons/icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: `${BASE}icons/icon-maskable-192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: `${BASE}icons/icon-maskable-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Plan',
            short_name: 'Plan',
            url: `${BASE}#/plan`,
            description: 'This week’s lunch and dinner board',
            icons: [{ src: `${BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Add recipe',
            short_name: 'Add recipe',
            url: `${BASE}#/capture`,
            description: 'Paste or import a new recipe',
            icons: [{ src: `${BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Shopping list',
            short_name: 'Shop',
            url: `${BASE}#/shop`,
            description: 'This week’s merged shopping list',
            icons: [{ src: `${BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' }],
          },
        ],
        // A hash `action` is not reliably honoured by the Web Share Target
        // API (some platforms drop/mangle the fragment before the share
        // completes), so this points at a real static path instead. That
        // path is public/share/index.html, which immediately forwards
        // location.search onto '#/capture?...'. See the long comment in that
        // file for the full reasoning.
        share_target: {
          action: `${BASE}share`,
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
      workbox: {
        // Precache every build artefact so a cold install works fully
        // offline the moment it's added to the home screen.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // The recipe-fetcher Worker (see worker/) is best-effort: try the
            // network briefly, then fall back to cache so a flaky connection
            // in a supermarket doesn't hang the import screen.
            urlPattern: fetcherOriginPattern,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'recipe-fetcher',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Recipe photos: large, immutable once fetched, and exactly the
            // kind of thing you want to still see with no signal.
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'recipe-photos',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  };
});
