import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Stable id — passing the same id updates the existing toast in place
   * (used by the SW-update toast, which is shown once and then just sits
   * there) instead of stacking a duplicate. */
  id?: string;
  message: string;
  variant?: 'default' | 'success' | 'error';
  action?: ToastAction;
  /** ms before auto-dismiss. 0 (or omitted with an `action`) means it stays
   * until dismissed or acted on — used for the SW-update prompt, which must
   * not disappear on its own mid-shop. @default 4000 */
  duration?: number;
}

interface ToastRecord extends Required<Pick<ToastOptions, 'message' | 'variant'>> {
  id: string;
  action?: ToastAction;
}

interface ToastContextValue {
  show: (options: ToastOptions | string) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let autoId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions | string) => {
      const opts: ToastOptions = typeof options === 'string' ? { message: options } : options;
      const id = opts.id ?? `toast-${++autoId}`;
      const record: ToastRecord = {
        id,
        message: opts.message,
        variant: opts.variant ?? 'default',
        action: opts.action,
      };

      setToasts((prev) => {
        const exists = prev.some((t) => t.id === id);
        return exists ? prev.map((t) => (t.id === id ? record : t)) : [...prev, record];
      });

      const existingTimer = timers.current.get(id);
      if (existingTimer) clearTimeout(existingTimer);

      const duration = opts.duration ?? (opts.action ? 0 : 4000);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      } else {
        timers.current.delete(id);
      }

      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          // Sits above the bottom tab bar and its safe-area padding.
          bottom: 'calc(var(--bottom-bar-height) + env(safe-area-inset-bottom) + var(--space-3))',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '0 var(--space-4)',
          pointerEvents: 'none',
          zIndex: 300, // keep in sync with --z-toast in tokens.css
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              maxWidth: 480,
              width: '100%',
              background: t.variant === 'error' ? 'var(--color-danger)' : 'var(--color-text)',
              color: 'var(--color-text-on-primary)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3) var(--space-4)',
              boxShadow: 'var(--shadow-lg)',
              fontSize: 'var(--font-size-sm)',
              animation: 'meals-toast-in var(--motion-base) var(--ease-standard)',
            }}
          >
            <span style={{ flex: 1 }}>{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="tap-target"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                style={{
                  color: 'var(--color-primary-strong)',
                  fontWeight: 'var(--font-weight-bold)',
                  padding: '0 var(--space-2)',
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss"
              className="tap-target"
              onClick={() => dismiss(t.id)}
              style={{ color: 'inherit', opacity: 0.8, width: 32, minWidth: 32 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * `useToast().show(...)` displays a toast; `.dismiss(id)` hides it early.
 * `show` returns the toast's id so callers can dismiss it programmatically
 * (e.g. an optimistic write that later fails and wants to replace its own
 * "Saved" toast with an error).
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
