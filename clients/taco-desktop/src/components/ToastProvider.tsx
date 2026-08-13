/**
 * ToastProvider — global toast container + Context Provider.
 * Must be rendered near the root so descendants can call `useToast()`.
 */
import type { ReactNode } from "react";
import { ToastContext, type ToastLevel, useToastManager } from "../hooks/useToast";

export type { ToastLevel };

export function ToastProvider({ children }: { children: ReactNode }) {
    const { state, show, dismiss } = useToastManager();

    return (
        <ToastContext.Provider value={{ show, dismiss }}>
            {children}
            {state && (
                <div className="toast-overlay">
                    <div className="toast-card" data-level={state.level} role="alert">
                        <span>{state.message}</span>
                        <button type="button" onClick={dismiss} aria-label="Dismiss">
                            ✕
                        </button>
                    </div>
                </div>
            )}
        </ToastContext.Provider>
    );
}
