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
          // Solid, opaque bar. It extends through the home-indicator safe area
          // (padding-bottom below) down to the physical bottom edge, so the bar
          // reads as one thing anchored to the bottom of the screen rather than
          // a floating strip with empty space beneath it. (A translucent bar
          // let the dark page show through that zone, which looked like dead
          // space in the installed PWA.)
          background: 'var(--color-surface)',
          borderTop: '1px solid var(--color-border)',
          // The safe-area allowance is folded into each tab's height/padding
          // below rather than added as empty padding here. Adding it here
          // parked the labels at the top of the bar and left the whole
          // home-indicator band beneath them blank — visible dead space on
          // devices with a large bottom inset.
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
              // The tap target spans the full bar zone (base height + the
              // bottom safe-area inset), and the icon + label are bottom-
              // aligned within it. This drops them down into the home-indicator
              // band — filling what was empty space — while keeping a small
              // clearance above the physical bottom edge.
              justifyContent: 'flex-end',
              gap: 2,
              height: 'calc(var(--bottom-bar-height) + env(safe-area-inset-bottom))',
              paddingBottom: 'calc(var(--space-2) + env(safe-area-inset-bottom) * 0.35)',
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
