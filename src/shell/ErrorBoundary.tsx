import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback renderer. Defaults to a generic "something went wrong". */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors in a subtree (a screen, a bottom sheet body) so one
 * broken recipe or one bad parse doesn't white-screen the whole app. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-8) var(--space-5)',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--color-danger-soft)',
            color: 'var(--color-danger)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="x" size={28} />
        </div>
        <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'var(--font-weight-bold)' }}>
          Something went wrong
        </h2>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', maxWidth: 320 }}>
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button type="button" className="btn btn--secondary tap-target" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}
