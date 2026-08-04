/** A small inline loading indicator. Respects prefers-reduced-motion by
 * falling back to a static ring (handled in global.css's blanket rule). */
export interface SpinnerProps {
  size?: number;
  label?: string;
}

export function Spinner({ size = 24, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      style={{ display: 'inline-flex', width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="spinner-ring">
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="var(--color-border)"
          strokeWidth="3"
          fill="none"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="var(--color-primary)"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
