import { NavLink, Outlet } from 'react-router-dom';
import { Icon, type IconName } from './Icon';

interface Tab {
  to: string;
  label: string;
  icon: IconName;
}

const TABS: Tab[] = [
  { to: '/plan', label: 'Plan', icon: 'calendar' },
  { to: '/recipes', label: 'Recipes', icon: 'book' },
  { to: '/shop', label: 'Shop', icon: 'basket' },
];

/**
 * App chrome: a scrollable content area plus a safe-area-aware bottom tab
 * bar for the three primary destinations. Screens render into the
 * `<Outlet />`; anything not in the tab bar (capture, import, recipe
 * detail, settings) is reached by navigating from within a screen, not from
 * here.
 */
export function AppShell() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          // Keep content (and each screen's sticky header) clear of the iOS
          // status bar / notch — the app draws under it because of
          // viewport-fit=cover + the translucent status-bar style. A sticky
          // top:0 header inside a screen parks at this padding edge, so it
          // sits just below the clock rather than under it.
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'calc(var(--bottom-bar-height) + env(safe-area-inset-bottom))',
        }}
      >
        <Outlet />
      </main>

      <nav
        aria-label="Primary"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 100, // keep in sync with --z-bottom-bar in tokens.css
          display: 'flex',
          // 50% transparent so a little of the plan (e.g. Sunday) shows through
          // beneath the bar. The tabs themselves stay opaque and tappable; only
          // the surrounding whitespace lets the content behind peek through.
          background: 'color-mix(in srgb, var(--color-surface) 50%, transparent)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderTop: '1px solid var(--color-border)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className="tap-target"
            style={({ isActive }) => ({
              flex: 1,
              flexDirection: 'column',
              // Bottom-align the icon + label so they sit just above the
              // home-indicator safe area rather than floating in the middle of
              // the bar — that centred gap was the dead space below the tabs.
              justifyContent: 'flex-end',
              gap: 2,
              height: 'var(--bottom-bar-height)',
              paddingBottom: 'var(--space-1)',
              color: isActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: isActive ? 700 : 500,
            })}
          >
            {({ isActive }) => (
              <>
                <Icon name={tab.icon} size={24} />
                <span>{tab.label}</span>
                <span className="visually-hidden">{isActive ? ' (current)' : ''}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
