import { Component, type ReactNode } from "react";

/**
 * Keeps a render error inside the part of the page that threw it. React unmounts the whole
 * tree on an uncaught render error, so one transcript entry the chat cannot draw would
 * otherwise leave the app blank. A change of `resetKey` (new data, another pane) tries again.
 */
interface Props {
  resetKey: unknown;
  fallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

export class RenderBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("render failed", error);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  private retry = (): void => this.setState({ failed: false });

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
