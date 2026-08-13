/**
 * ErrorBoundary — top-level React error boundary.
 *
 * React's limitation: event handlers, async, and SSR errors are NOT caught
 * here — only synchronous throws during subtree rendering. Event-handler
 * errors are handled locally with try/catch.
 */
import { Component, type ReactNode } from "react";

import { useT } from "../i18n/useI18n";
import { Button } from "./ui/Button.tsx";

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Functional fallback renderer — separated from the class so it can call
 * react-i18next's `useT()` hook. The class delegates to it.
 */
function ErrorFallback({ error, reset }: { error: Error; reset: () => void }): ReactNode {
    const { t } = useT();
    const handleReload = (): void => {
        window.location.reload();
    };

    return (
        <div className="error-fallback-backdrop">
            <div className="error-fallback" role="alert">
                <h2 className="error-fallback-title">{t("app.errorBoundaryTitle")}</h2>
                <p className="error-fallback-message">
                    The application hit an unexpected error. You can try resetting the interface, or
                    reload the window if the issue persists.
                </p>
                <details className="error-fallback-details">
                    <summary>{t("app.errorDetails")}</summary>
                    <pre className="error-fallback-pre">{error.message}</pre>
                </details>
                <div className="error-fallback-actions">
                    <Button variant="ghost" onClick={reset}>
                        {t("app.reset")}
                    </Button>
                    <Button variant="primary" onClick={handleReload}>
                        {t("app.reload")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export class ErrorBoundary extends Component<Props, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: { componentStack?: string }): void {
        console.error("[ErrorBoundary]", error, info.componentStack);
    }

    private handleReset = () => {
        this.setState({ error: null });
    };

    override render() {
        const { error } = this.state;
        if (error === null) return this.props.children;

        return <ErrorFallback error={error} reset={this.handleReset} />;
    }
}
