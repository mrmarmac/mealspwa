import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /**
   * Fractions of viewport height (0–1, ascending) the sheet can rest at,
   * e.g. `[0.4, 0.9]`. A drag settles to the nearest snap point on release;
   * dragging below the smallest one (past a small extra threshold) closes
   * the sheet. Omit for a single content-sized sheet (capped at 90vh) with
   * no intermediate stops — the common case for menus and short forms.
   */
  snapPoints?: number[];
  /** Index into `snapPoints` to open at. @default last (tallest) entry. */
  initialSnapIndex?: number;
  /** Hides the drag handle / disables swipe-to-dismiss. Rarely needed. */
  disableSwipe?: boolean;
  /** Hides the header close (×) button while keeping the title. The sheet can
   * still be dismissed by tapping the backdrop, Escape, or swiping down. */
  hideClose?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A general-purpose accessible bottom sheet: focus trap, Escape-to-close,
 * backdrop click, `aria-modal`, body scroll lock, swipe-to-dismiss, and
 * optional multi-height snap points. Used throughout the app for pickers
 * and menus (recipe picker, meal editor, etc.) — keep new usages to this
 * one component rather than growing bespoke sheets.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  snapPoints,
  initialSnapIndex,
  disableSwipe,
  hideClose,
}: BottomSheetProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const points = useMemo(
    () => (snapPoints && snapPoints.length > 0 ? [...snapPoints].sort((a, b) => a - b) : null),
    [snapPoints],
  );
  const [snapIndex, setSnapIndex] = useState(() =>
    points ? Math.min(initialSnapIndex ?? points.length - 1, points.length - 1) : 0,
  );
  useEffect(() => {
    if (open && points) setSnapIndex(Math.min(initialSnapIndex ?? points.length - 1, points.length - 1));
    // Only re-run when the sheet opens, not on every prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Drag state. `dragY` is the live pointer-follow offset in px (0 = resting
  // position); it's cleared back to 0 on release once we've committed the
  // gesture to a new snapIndex or to onClose.
  const [dragY, setDragY] = useState(0);
  const dragState = useRef<{ startY: number; active: boolean } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ---- body scroll lock -----------------------------------------------
  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  // ---- focus trap: move focus in on open, restore on close ------------
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const el = sheetRef.current;
    const first = el?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? el)?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // ---- Escape + Tab trap -------------------------------------------
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = sheetRef.current;
      if (!el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (node) => node.offsetParent !== null,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

  // ---- swipe to dismiss / snap ------------------------------------
  const heightPx = points
    ? typeof window !== 'undefined'
      ? points[snapIndex]! * window.innerHeight
      : undefined
    : undefined;

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disableSwipe) return;
      dragState.current = { startY: e.clientY, active: true };
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [disableSwipe],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state?.active) return;
    const delta = e.clientY - state.startY;
    // Only allow dragging downward past the topmost snap point.
    setDragY(Math.max(0, delta));
  }, []);

  const commitDrag = useCallback(() => {
    const state = dragState.current;
    dragState.current = null;
    setIsDragging(false);
    if (!state) return;

    const CLOSE_THRESHOLD = 90;
    if (!points) {
      if (dragY > CLOSE_THRESHOLD) onClose();
      setDragY(0);
      return;
    }

    const vh = window.innerHeight;
    const currentHeight = points[snapIndex]! * vh;
    const draggedFraction = (currentHeight - dragY) / vh;

    if (dragY > CLOSE_THRESHOLD && snapIndex === 0) {
      onClose();
      setDragY(0);
      return;
    }

    // Snap to whichever point is closest to where the drag left off.
    let nearest = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p - draggedFraction);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setSnapIndex(nearest);
    setDragY(0);
  }, [dragY, onClose, points, snapIndex]);

  if (!open) return null;

  const reducedMotion = prefersReducedMotion();

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200, // keep in sync with --z-sheet in tokens.css
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--color-overlay)',
          animation: reducedMotion ? undefined : 'meals-sheet-backdrop-in var(--motion-base) var(--ease-standard)',
        }}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className="sheet"
        onPointerUp={commitDrag}
        onPointerCancel={commitDrag}
        style={{
          position: 'relative',
          maxHeight: '90vh',
          height: heightPx ? `${heightPx}px` : undefined,
          display: 'flex',
          flexDirection: 'column',
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition:
            isDragging || reducedMotion
              ? 'none'
              : 'transform var(--motion-base) var(--ease-standard), height var(--motion-base) var(--ease-standard)',
          animation:
            !isDragging && dragY === 0 && !reducedMotion
              ? 'meals-sheet-in var(--motion-base) var(--ease-standard)'
              : undefined,
        }}
      >
        {!disableSwipe && (
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: 'var(--space-2) 0',
              touchAction: 'none',
              cursor: 'grab',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 36,
                height: 4,
                borderRadius: 'var(--radius-pill)',
                background: 'var(--color-border)',
              }}
            />
          </div>
        )}
        {title ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 var(--space-4) var(--space-3)',
            }}
          >
            <h2 id={titleId} style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'var(--font-weight-bold)' }}>
              {title}
            </h2>
            {!hideClose && (
              <button
                type="button"
                aria-label="Close"
                className="tap-target"
                onClick={onClose}
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <Icon name="x" size={22} />
              </button>
            )}
          </div>
        ) : null}
        <div style={{ overflowY: 'auto', flex: 1, padding: '0 var(--space-4) var(--space-4)' }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
