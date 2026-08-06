import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export interface LongPressMenuItem {
  key: string;
  label: string;
  icon?: IconName;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** Props to spread onto whatever element should trigger the menu (a
 * placement card, a list row, ...). */
export interface LongPressMenuTriggerProps {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onClick: (e: ReactMouseEvent) => void;
}

export interface LongPressMenuProps {
  items: LongPressMenuItem[];
  /** Render-prop so the trigger can be any element (card, row, chip). Spread
   * the returned props onto it. */
  children: (trigger: LongPressMenuTriggerProps) => ReactNode;
  /** Hold duration before a touch counts as long-press. @default 500 */
  pressDurationMs?: number;
  /** Finger movement, in px, that cancels a pending long-press. @default 10 */
  moveCancelThresholdPx?: number;
  /**
   * Open on a plain desktop left-click (or keyboard activation) rather than a
   * right-click, and make right-click a no-op. Touch is unchanged — long-press
   * opens, a short tap does nothing. Used by the plan board's placed meal
   * cards, where a tap should reveal actions, not navigate away.
   */
  openOnClick?: boolean;
  disabled?: boolean;
}

const MENU_MARGIN = 8;

/**
 * A context menu that opens on a ~500ms touch hold (cancelled by movement
 * past a small threshold, so a scroll doesn't accidentally fire it) or a
 * desktop right-click, positioned so it never runs off-screen. Used for
 * things like the meal multiplier menu on a plan-board card.
 */
export function LongPressMenu({
  items,
  children,
  pressDurationMs = 500,
  moveCancelThresholdPx = 10,
  openOnClick = false,
  disabled,
}: LongPressMenuProps) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ left: number; top: number } | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Which input drove the last interaction — a `click` event alone can't tell a
  // mouse click from the tap that follows a touch, and only the mouse click
  // should open a click-to-open menu.
  const lastPointerTypeRef = useRef<string>('mouse');

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    setAnchor(null);
    setStyle(null);
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      lastPointerTypeRef.current = e.pointerType;
      if (disabled || e.pointerType === 'mouse') return; // mouse uses click/contextmenu
      const x = e.clientX;
      const y = e.clientY;
      startRef.current = { x, y };
      clearTimer();
      timerRef.current = setTimeout(() => {
        startRef.current = null;
        setAnchor({ x, y });
      }, pressDurationMs);
    },
    [clearTimer, disabled, pressDurationMs],
  );

  const onClick = useCallback(
    (e: ReactMouseEvent) => {
      if (disabled || !openOnClick) return;
      // A touch tap also fires `click`; only a real mouse click (or keyboard
      // activation) should open the menu — a tap must do nothing.
      if (lastPointerTypeRef.current === 'touch') return;
      let x = e.clientX;
      let y = e.clientY;
      // Keyboard activation carries no coordinates; anchor to the element.
      if (x === 0 && y === 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      setAnchor({ x, y });
    },
    [disabled, openOnClick],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > moveCancelThresholdPx) {
        clearTimer();
        startRef.current = null;
      }
    },
    [clearTimer, moveCancelThresholdPx],
  );

  const onPointerEnd = useCallback(() => {
    clearTimer();
    startRef.current = null;
  }, [clearTimer]);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      // For click-to-open triggers a right-click deliberately does nothing (the
      // native menu is still suppressed above).
      if (openOnClick) return;
      setAnchor({ x: e.clientX, y: e.clientY });
    },
    [disabled, openOnClick],
  );

  // Clamp the menu into the viewport once we know its rendered size.
  useLayoutEffect(() => {
    if (!anchor) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - MENU_MARGIN;
    const maxTop = window.innerHeight - rect.height - MENU_MARGIN;
    setStyle({
      left: Math.min(Math.max(anchor.x, MENU_MARGIN), Math.max(maxLeft, MENU_MARGIN)),
      top: Math.min(Math.max(anchor.y, MENU_MARGIN), Math.max(maxTop, MENU_MARGIN)),
    });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const handleScroll = () => close();
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor, close]);

  useEffect(() => clearTimer, [clearTimer]);

  return (
    <>
      {children({
        onPointerDown,
        onPointerMove,
        onPointerUp: onPointerEnd,
        onPointerCancel: onPointerEnd,
        onContextMenu,
        onClick,
      })}
      {anchor
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{
                position: 'fixed',
                left: style?.left ?? anchor.x,
                top: style?.top ?? anchor.y,
                visibility: style ? 'visible' : 'hidden',
                zIndex: 250, // keep in sync with --z-menu in tokens.css
                background: 'var(--color-surface)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-lg)',
                border: '1px solid var(--color-border)',
                minWidth: 200,
                padding: 'var(--space-1)',
                overflow: 'hidden',
              }}
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  role="menuitem"
                  type="button"
                  disabled={item.disabled}
                  className="tap-target"
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                  style={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    gap: 'var(--space-3)',
                    padding: '0 var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    color: item.destructive ? 'var(--color-danger)' : 'var(--color-text)',
                    fontSize: 'var(--font-size-md)',
                    opacity: item.disabled ? 0.5 : 1,
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size={20} /> : null}
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
