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
          // Reserve the home-indicator inset as padding on the bar itself. The
          // background (and top border) fill down through the inset to the
          // physical bottom edge, while this padding keeps the tappable tab row
          // — the icons and labels — above the indicator instead of colliding
          // with it. box-sizing keeps the bar's total height at the tab-row
          // height plus the inset.
          boxSizing: 'border-box',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
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
              // Tab row sits above the inset (reserved by the nav's
              // padding-bottom). Icon + label are centered within the base
              // bar height.
              justifyContent: 'center',
              gap: 2,
              height: 'var(--bottom-bar-height)',
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
