import type { SessionTarget } from "@taco-ai/protocol";
import type { ModelSelection } from "../../components/settings/ModelPicker";
import type { StagedAttachment } from "../attachments";

export type ConversationTarget =
    | ({ readonly kind: "session" } & SessionTarget)
    | { readonly kind: "draft"; readonly workspace: string; readonly draftId: string };
export type DraftTarget = ConversationTarget;

type Update<T> = T | ((previous: T) => T);

export interface DraftRecovery {
    readonly id: number;
    readonly target: ConversationTarget;
    readonly input: string;
    readonly attachments: StagedAttachment[];
    /** The transport could not determine whether the submission was accepted. */
    readonly uncertain?: boolean;
}

export interface DraftSubmission extends DraftRecovery {
    readonly revision: number;
    readonly selectedModel: ModelSelection | null;
}

export interface ConversationDraftState {
    readonly input: string;
    readonly attachments: StagedAttachment[];
    readonly revision: number;
    readonly selectedModel: ModelSelection | null;
    readonly recoveries: readonly DraftRecovery[];
}

interface Entry {
    target: ConversationTarget;
    state: ConversationDraftState;
    textRevision: number;
    redirect?: Entry;
    released: boolean;
}

interface Pending {
    entry: Entry;
    snapshot: DraftSubmission;
    textRevision: number;
    clearedRevision?: number;
}

export interface ConversationDraftHandle {
    getSnapshot(): ConversationDraftState;
    setInput(next: Update<string>): void;
    setAttachments(next: Update<StagedAttachment[]>): void;
    setSelectedModel(next: Update<ModelSelection | null>): void;
    beginSubmission(): DraftSubmission;
    recoverSubmission(id: number): void;
}

const emptyState = (): ConversationDraftState => ({
    input: "",
    attachments: [],
    revision: 0,
    selectedModel: null,
    recoveries: [],
});

function targetKey(target: ConversationTarget): string {
    const id = target.kind === "session" ? target.sessionId : target.draftId;
    return `${target.kind}:${JSON.stringify([target.workspace, id])}`;
}

function resolve(entry: Entry): Entry {
    return entry.redirect ? resolve(entry.redirect) : entry;
}

function apply<T>(next: Update<T>, previous: T): T {
    return typeof next === "function" ? (next as (value: T) => T)(previous) : next;
}

function sameAttachment(a: StagedAttachment, b: StagedAttachment): boolean {
    return a.id === b.id && a.previewUrl === b.previewUrl;
}

function mergeAttachments(
    first: StagedAttachment[],
    second: StagedAttachment[],
): StagedAttachment[] {
    return [
        ...first,
        ...second.filter((item) => !first.some((other) => sameAttachment(item, other))),
    ];
}

function prepend(first: string, second: string): string {
    return first && second ? `${first}\n${second}` : first || second;
}

/** Synchronous, in-memory owner. Bind before an await to capture a target's lifetime. */
export class ConversationDrafts {
    private entries = new Map<string, Entry>();
    private pending = new Map<number, Pending>();
    private urls = new Set<string>();
    private listeners = new Set<() => void>();
    private version = 0;
    private nextId = 0;
    private textRevision = 0;
    private disposed = false;

    constructor(private readonly revokeObjectURL = (url: string) => URL.revokeObjectURL(url)) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getVersion = (): number => this.version;

    bind(
        target: ConversationTarget,
        initialModel: ModelSelection | null = null,
    ): ConversationDraftHandle {
        const handle = this.prepare(target, initialModel);
        handle.commit();
        return handle;
    }

    /** Reading a prepared handle does not acquire ownership until commit or its first event. */
    prepare(
        target: ConversationTarget,
        initialModel: ModelSelection | null = null,
    ): ConversationDraftHandle & { commit(): void } {
        const key = targetKey(target);
        let origin = this.entries.get(key);
        const initialState = { ...emptyState(), selectedModel: initialModel };
        const getSnapshot = () => {
            const entry = origin ?? this.entries.get(key);
            return entry ? resolve(entry).state : initialState;
        };
        const activate = (): Entry => {
            if (!origin) {
                origin = this.entries.get(key) ?? {
                    target: { ...target },
                    state: initialState,
                    textRevision: ++this.textRevision,
                    released: this.disposed,
                };
                if (!this.disposed) this.entries.set(key, origin);
            }
            return resolve(origin);
        };
        return {
            commit: () => {
                activate();
            },
            getSnapshot,
            setInput: (next) => this.setInput(activate(), next),
            setAttachments: (next) => {
                const entry = activate();
                const attachments = apply(next, entry.state.attachments);
                this.trackUrls(attachments);
                if (!entry.released) this.update(entry, { attachments: [...attachments] });
                else this.sweepUrls();
            },
            setSelectedModel: (next) => {
                const entry = activate();
                if (!entry.released) {
                    this.update(entry, { selectedModel: apply(next, entry.state.selectedModel) });
                }
            },
            beginSubmission: () => {
                const entry = activate();
                const snapshot: DraftSubmission = {
                    id: ++this.nextId,
                    target: { ...entry.target },
                    input: entry.state.input,
                    attachments: entry.state.attachments.map((attachment) => ({ ...attachment })),
                    revision: entry.state.revision,
                    selectedModel: entry.state.selectedModel
                        ? { ...entry.state.selectedModel }
                        : null,
                };
                if (!entry.released) {
                    this.pending.set(snapshot.id, {
                        entry,
                        snapshot,
                        textRevision: entry.textRevision,
                    });
                }
                return snapshot;
            },
            recoverSubmission: (id) => {
                const entry = activate();
                const recovery = entry.state.recoveries.find((item) => item.id === id);
                if (!recovery || entry.released) return;
                this.update(entry, {
                    input: prepend(recovery.input, entry.state.input),
                    attachments: mergeAttachments(recovery.attachments, entry.state.attachments),
                    recoveries: entry.state.recoveries.filter((item) => item.id !== id),
                });
            },
        };
    }

    completeSubmission = (snapshot: DraftSubmission, success: boolean | "unknown"): void => {
        const pending = this.pending.get(snapshot.id);
        // Identity also rejects another manager's snapshot and repeated completions.
        if (!pending || pending.snapshot !== snapshot) return;
        const entry = resolve(pending.entry);
        this.pending.delete(snapshot.id);
        if (entry.released) return;
        const state = entry.state;
        if (success === true) {
            this.update(entry, {
                input:
                    entry.textRevision === pending.textRevision && state.input === snapshot.input
                        ? ""
                        : state.input,
                attachments: state.attachments.filter(
                    (item) =>
                        !snapshot.attachments.some((submitted) => sameAttachment(item, submitted)),
                ),
            });
        } else if (
            success === false &&
            ((entry.textRevision === pending.textRevision && state.input === snapshot.input) ||
                (entry.textRevision === pending.clearedRevision && state.input === ""))
        ) {
            this.update(entry, {
                input: snapshot.input,
                attachments: mergeAttachments(snapshot.attachments, state.attachments),
            });
        } else {
            // Unknown acceptance always needs explicit recovery, even after an
            // untouched optimistic clear; restoring here could invite a duplicate send.
            this.update(entry, {
                recoveries: [
                    ...state.recoveries,
                    {
                        id: snapshot.id,
                        target: { ...entry.target },
                        input: snapshot.input,
                        attachments: snapshot.attachments,
                        ...(success === "unknown" ? { uncertain: true } : {}),
                    },
                ],
            });
        }
    };

    restoreTexts = (target: ConversationTarget, texts: readonly string[]): void => {
        if (texts.length === 0 || this.disposed) return;
        const handle = this.bind(target);
        handle.setInput((current) => prepend(texts.join("\n"), current));
    };

    migrateDraft = (workspace: string, draftId: string, sessionId: string): void => {
        if (this.disposed) return;
        const from: ConversationTarget = { kind: "draft", workspace, draftId };
        const to: ConversationTarget = { kind: "session", workspace, sessionId };
        this.bind(from);
        const sourceEntry = this.entries.get(targetKey(from));
        if (!sourceEntry) return;
        const source = resolve(sourceEntry);
        const destinationEntry = this.entries.get(targetKey(to));
        const destination = destinationEntry ? resolve(destinationEntry) : undefined;
        if (source === destination) return;
        if (destination) {
            const mergedInput = prepend(source.state.input, destination.state.input);
            if (mergedInput !== source.state.input) source.textRevision = ++this.textRevision;
            source.state = {
                input: mergedInput,
                attachments: mergeAttachments(
                    source.state.attachments,
                    destination.state.attachments,
                ),
                selectedModel: source.state.selectedModel ?? destination.state.selectedModel,
                revision: Math.max(source.state.revision, destination.state.revision),
                recoveries: [...source.state.recoveries, ...destination.state.recoveries],
            };
            destination.redirect = source;
        }
        source.target = to;
        this.entries.set(targetKey(to), source);
        this.update(source, {
            recoveries: source.state.recoveries.map((item) => ({ ...item, target: { ...to } })),
        });
    };

    release = (target: ConversationTarget): void => {
        const captured = this.entries.get(targetKey(target));
        if (!captured) return;
        const entry = resolve(captured);
        entry.released = true;
        entry.state = emptyState();
        for (const [key, value] of this.entries) {
            if (resolve(value) === entry) this.entries.delete(key);
        }
        for (const [id, pending] of this.pending) {
            if (resolve(pending.entry) === entry) this.pending.delete(id);
        }
        this.changed();
    };

    dispose = (): void => {
        if (this.disposed) return;
        this.disposed = true;
        for (const entry of this.entries.values()) {
            const current = resolve(entry);
            current.released = true;
            current.state = emptyState();
        }
        this.entries.clear();
        this.pending.clear();
        this.changed();
        this.listeners.clear();
    };

    private setInput(entry: Entry, next: Update<string>): void {
        if (entry.released) return;
        const input = apply(next, entry.state.input);
        if (input === entry.state.input) return;
        this.update(entry, { input });
    }

    private update(entry: Entry, patch: Partial<ConversationDraftState>): void {
        if (patch.input !== undefined && patch.input !== entry.state.input) {
            const previousRevision = entry.textRevision;
            entry.textRevision = ++this.textRevision;
            for (const pending of this.pending.values()) {
                if (
                    patch.input === "" &&
                    resolve(pending.entry) === entry &&
                    pending.textRevision === previousRevision
                ) {
                    pending.clearedRevision = entry.textRevision;
                }
            }
        }
        entry.state = { ...entry.state, ...patch, revision: entry.state.revision + 1 };
        this.changed();
    }

    private changed(): void {
        this.sweepUrls();
        this.version++;
        for (const listener of this.listeners) listener();
    }

    private trackUrls(attachments: readonly StagedAttachment[], into = this.urls): void {
        for (const attachment of attachments) {
            if (attachment.previewUrl?.startsWith("blob:")) into.add(attachment.previewUrl);
        }
    }

    private sweepUrls(): void {
        const retained = new Set<string>();
        for (const entry of new Set([...this.entries.values()].map(resolve))) {
            this.trackUrls(entry.state.attachments, retained);
            for (const recovery of entry.state.recoveries)
                this.trackUrls(recovery.attachments, retained);
        }
        for (const pending of this.pending.values())
            this.trackUrls(pending.snapshot.attachments, retained);
        for (const url of this.urls) {
            if (!retained.has(url)) {
                this.urls.delete(url);
                this.revokeObjectURL(url);
            }
        }
    }
}
