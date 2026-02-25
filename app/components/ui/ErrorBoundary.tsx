import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('[ErrorBoundary]', error.message, errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  private _handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center p-8 gap-4 min-h-[200px]">
          <div className="i-ph:warning-circle-duotone text-4xl text-bolt-elements-icon-error" />
          <h3 className="text-lg font-semibold text-bolt-elements-textPrimary">Something went wrong</h3>
          <p className="text-sm text-bolt-elements-textSecondary max-w-md text-center">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={this._handleRetry}
            className="px-4 py-2 rounded-md text-sm font-medium
              bg-bolt-elements-button-primary-background
              text-bolt-elements-button-primary-text
              hover:bg-bolt-elements-button-primary-backgroundHover
              transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
