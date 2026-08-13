/**
 * Shared `ModelOption` / `ModelSelection` types for the model-picker.
 * Types only — the picker UI lives in ModelMenu.tsx.
 */

export interface ModelOption {
    provider: string;
    id: string;
    name?: string;
}

export interface ModelSelection {
    provider: string;
    id: string;
}
