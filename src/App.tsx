import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { AppShell } from '@/shell/AppShell';
import { ErrorBoundary } from '@/shell/ErrorBoundary';
import { Spinner } from '@/shell/Spinner';
import { ToastProvider, useToast } from '@/shell/Toast';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useSyncStore } from '@/store/useSyncStore';

// ---------------------------------------------------------------------------
// Screens are owned by the other agents and do not exist in this tree yet.
// Each lazy import below is the exact module path + default export name the
// owning agent must add under src/screens/:
//
//   @/screens/PlanScreen         -> default export `PlanScreen`
//   @/screens/RecipesScreen      -> default export `RecipesScreen`
//   @/screens/RecipeDetailScreen -> default export `RecipeDetailScreen`
//   @/screens/CaptureScreen      -> default export `CaptureScreen`
//   @/screens/ImportScreen       -> default export `ImportScreen`
//   @/screens/ShopScreen         -> default export `ShopScreen`
//   @/screens/SettingsScreen     -> default export `SettingsScreen`
//
// Until those land, `tsc`/`vite build` fail on exactly these seven imports
// — that's expected. Nothing in src/screens/ is created by the shell.
// ---------------------------------------------------------------------------
const PlanScreen = lazy(() => import('@/screens/PlanScreen'));
const RecipesScreen = lazy(() => import('@/screens/RecipesScreen'));
const RecipeDetailScreen = lazy(() => import('@/screens/RecipeDetailScreen'));
const CaptureScreen = lazy(() => import('@/screens/CaptureScreen'));
const ImportScreen = lazy(() => import('@/screens/ImportScreen'));
const ShopScreen = lazy(() => import('@/screens/ShopScreen'));
const SettingsScreen = lazy(() => import('@/screens/SettingsScreen'));

// ---------------------------------------------------------------------------
// Sync driver. Ensures the active space is loaded, then drives the sync loop
// for it. When the build has no VITE_SYNC_URL (or the device hasn't enabled
// sync), start() is a cheap no-op — the app stays local-only. Renders nothing.
// ---------------------------------------------------------------------------

function SyncController() {
  const initSpace = useSpaceStore((s) => s.init);
  const spaceId = useSpaceStore((s) => s.space?.id ?? null);
  const start = useSyncStore((s) => s.start);
  const stop = useSyncStore((s) => s.stop);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (!spaceId) return;
    void start(spaceId);
    return () => stop();
  }, [spaceId, start, stop]);

  return null;
}

function FullScreenSpinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-9)' }}>
      <Spinner size={32} />
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/plan" replace />} />
        {/* The thing you check most (the board) is the default screen —
            both here and via the manifest's start_url — not the library. */}
        <Route path="plan" element={<PlanScreen />} />
        <Route path="recipes" element={<RecipesScreen />} />
        <Route path="recipes/:id" element={<RecipeDetailScreen />} />
        <Route path="capture" element={<CaptureScreen />} />
        <Route path="import" element={<ImportScreen />} />
        <Route path="shop" element={<ShopScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/plan" replace />} />
      </Route>
    </Routes>
  );
}

// ---------------------------------------------------------------------------
// Service-worker update prompt. registerType is 'prompt' (see vite.config.ts)
// specifically so this never force-reloads out from under someone mid-shop
// — it just offers, via the toast's action button, and waits.
// ---------------------------------------------------------------------------

function PwaUpdatePrompt() {
  const toast = useToast();
  const {
    needRefresh: [needRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // Registration failing is not fatal — the app still runs, it just
      // won't be installable/offline until a future load succeeds.
      console.error('Service worker registration failed', error);
    },
  });

  useEffect(() => {
    if (!needRefresh) return;
    toast.show({
      id: 'sw-update-available',
      message: 'An update is ready.',
      duration: 0, // stays until acted on — no surprise reloads mid-shop
      action: {
        label: 'Reload',
        onClick: () => {
          void updateServiceWorker(true);
        },
      },
    });
  }, [needRefresh, toast, updateServiceWorker]);

  useEffect(() => {
    if (!offlineReady) return;
    toast.show({ message: 'Ready to work offline.' });
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady, toast]);

  return null;
}

// ---------------------------------------------------------------------------
// Offline indicator — a thin, unmissable banner, not a toast, because it
// needs to persist for as long as the connection is actually down.
// ---------------------------------------------------------------------------

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

function OfflineIndicator() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="status"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 150,
        textAlign: 'center',
        padding: 'var(--space-1) var(--space-3)',
        paddingTop: 'calc(var(--space-1) + env(safe-area-inset-top))',
        background: 'var(--color-warning-soft)',
        color: 'var(--color-warning)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-medium)',
      }}
    >
      Offline — showing what's already saved on this device
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Add to home screen" banner. `beforeinstallprompt` only fires on
// Chromium-based browsers (Chrome/Edge on Android and desktop); iOS Safari
// never fires it — installing there is the manual Share -> "Add to Home
// Screen" flow, which no web API can trigger, so this banner simply never
// appears on iOS. That's fine: the manifest + apple-touch-icon still make
// that manual install work correctly.
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const INSTALL_DISMISSED_KEY = 'meals:install-dismissed';

function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      // Private browsing etc. — worst case the banner reappears next visit.
    }
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }, [deferred]);

  return { visible: deferred !== null && !dismissed, install, dismiss };
}

function InstallBanner() {
  const { visible, install, dismiss } = useInstallPrompt();
  if (!visible) return null;
  return (
    <div
      role="region"
      aria-label="Install"
      className="card"
      style={{
        position: 'fixed',
        left: 'var(--space-3)',
        right: 'var(--space-3)',
        bottom: 'calc(var(--bottom-bar-height) + env(safe-area-inset-bottom) + var(--space-3))',
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ flex: 1 }}>
        <p style={{ fontWeight: 'var(--font-weight-bold)' }}>Add Meals to your home screen</p>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          Opens straight to the plan, works offline in the shop.
        </p>
      </div>
      <button type="button" className="btn btn--secondary tap-target" onClick={dismiss}>
        Not now
      </button>
      <button
        type="button"
        className="btn btn--primary tap-target"
        onClick={() => {
          void install();
        }}
      >
        Add
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HashRouter, deliberately: GitHub Pages serves this app from a static
// subpath (mrmarmac.github.io/mealspwa/) with no server-side rewrite rules,
// so a browser (or history) request for e.g. /mealspwa/recipes/abc would
// 404 — Pages has no way to route it back to index.html. Hash routes never
// leave index.html as far as the server is concerned, so deep links, the
// installed manifest's start_url (#/plan), and offline navigation
// (navigateFallback in vite.config.ts) all work with zero server config.
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <PwaUpdatePrompt />
        <SyncController />
        <OfflineIndicator />
        <InstallBanner />
        <ErrorBoundary>
          <Suspense fallback={<FullScreenSpinner />}>
            <AppRoutes />
          </Suspense>
        </ErrorBoundary>
      </ToastProvider>
    </HashRouter>
  );
}
