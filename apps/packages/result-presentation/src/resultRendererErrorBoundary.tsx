import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ResultRendererErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ResultRendererErrorBoundaryState {
  error?: Error;
}

export class ResultRendererErrorBoundary extends Component<
  ResultRendererErrorBoundaryProps,
  ResultRendererErrorBoundaryState
> {
  state: ResultRendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ResultRendererErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      return typeof fallback === "function" ? fallback(error) : fallback ?? null;
    }
    return this.props.children;
  }
}
