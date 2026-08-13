/// <reference types="vite/client" />
/**
 * Non-blocking single-toast notifications.
 * `createToastManager` provides framework-free state and pub/sub;
 * `useToastManager` mirrors it into React. `useToast` requires ToastProvider:
 * development throws without it, while production returns a no-op context.
 * Each `show()` replaces the current toast instead of queueing.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ToastLevel = "info" | "warn" | "error";

export interface ToastState {
    message: string;
    level: ToastLevel;
}

export interface ToastManager {
    show: (message: string, level?: ToastLevel) => void;
    dismiss: () => void;
    state: () => ToastState | null;
    subscribe: (listener: () => void) => () => void;
}

export interface ToastManagerOptions {
    /** Auto-dismiss duration. Default 5000ms. */
    defaultDurationMs?: number;
}

export function createToastManager(options: ToastManagerOptions = {}): ToastManager {
    const defaultDurationMs = options.defaultDurationMs ?? 5000;
    let current: ToastState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listeners = new Set<() => void>();

    function notify() {
        for (const fn of listeners) fn();
    }

    function clearTimer() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    return {
        show(message: string, level: ToastLevel = "info") {
            clearTimer();
            current = { message, level };
            notify();
            timer = setTimeout(() => {
                current = null;
                timer = null;
                notify();
            }, defaultDurationMs);
        },
        dismiss() {
            clearTimer();
            if (current === null) return;
            current = null;
            notify();
        },
        state() {
            return current;
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

interface ToastContextValue {
    show: (message: string, level?: ToastLevel) => void;
    dismiss: () => void;
}

// Exported because `<ToastContext.Provider>` lives in `ToastProvider.tsx`
// and React requires Provider/Consumer to share the same Context instance.
// External code should use `useToast()` instead of touching this directly.
export const ToastContext = createContext<ToastContextValue | null>(null);
ToastContext.displayName = "ToastContext";

const NOOP_CONTEXT: ToastContextValue = {
    show: () => {},
    dismiss: () => {},
};

/**
 * Consumer hook. Must be called inside `<ToastProvider>`.
 *
 * Outside the provider: dev throws, prod silently no-ops. Tests should wrap
 * in `<ToastProvider>` like any other context-consuming test.
 */
export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (ctx) return ctx;
    if (import.meta.env.DEV) {
        throw new Error("useToast() called outside <ToastProvider>.");
    }
    return NOOP_CONTEXT;
}

/**
 * Used by `<ToastProvider>` to mirror the manager's state into React.
 *
 * `manager` is stable for the lifetime of the component (never reassigned),
 * so we can use lazy `useState` init instead of a useRef-null-check pattern.
 */
export function useToastManager() {
    // One stable manager per component. Lazy `useState` init gives us a
    // value that's never reassigned without the useRef-null-check dance.
    const [manager] = useState(() => createToastManager());
    const [state, setState] = useState<ToastState | null>(() => manager.state());

    useEffect(() => {
        return manager.subscribe(() => setState(manager.state()));
    }, [manager]);

    const show = useCallback(
        (message: string, level: ToastLevel = "info") => manager.show(message, level),
        [manager],
    );
    const dismiss = useCallback(() => manager.dismiss(), [manager]);

    return { state, show, dismiss };
}
