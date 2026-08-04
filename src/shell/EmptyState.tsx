import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** A centred placeholder for empty lists — no recipes yet, nothing planned
 * this week, an empty shopping list. */
export function EmptyState({ icon = 'book', title, description, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-8) var(--space-5)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 'var(--radius-pill)',
          background: 'var(--color-primary-soft)',
          color: 'var(--color-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={28} />
      </div>
      <h2
        style={{
          fontSize: 'var(--font-size-lg)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--color-text)',
        }}
      >
        {title}
      </h2>
      {description ? <p style={{ fontSize: 'var(--font-size-sm)', maxWidth: 320 }}>{description}</p> : null}
      {action ? <div style={{ marginTop: 'var(--space-2)' }}>{action}</div> : null}
    </div>
  );
}
