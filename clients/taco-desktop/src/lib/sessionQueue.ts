/** Serial lanes for composite session targets. Invalidating releases new work immediately;
 * old RPCs may finish, but their continuation must check isCurrent before writing. */
export class SessionQueue {
    private generation = 0;
    private readonly epochs = new Map<string, number>();
    private readonly tails = new Map<string, { workspace: string; promise: Promise<void> }>();

    run<T>(
        workspace: string,
        session: string,
        task: (isCurrent: () => boolean) => Promise<T>,
    ): Promise<T | undefined> {
        const key = `${workspace}\u0000${session}`;
        const generation = this.generation;
        const epoch = this.epochs.get(workspace) ?? 0;
        const isCurrent = () =>
            generation === this.generation && epoch === (this.epochs.get(workspace) ?? 0);
        const result = (this.tails.get(key)?.promise ?? Promise.resolve()).then(() =>
            isCurrent() ? task(isCurrent) : undefined,
        );
        const promise = result.then(
            () => {},
            () => {},
        );
        this.tails.set(key, { workspace, promise });
        void promise.then(() => {
            if (this.tails.get(key)?.promise === promise) this.tails.delete(key);
        });
        return result;
    }

    invalidate(workspace?: string): void {
        if (workspace === undefined) {
            this.generation++;
            this.epochs.clear();
            this.tails.clear();
            return;
        }
        this.epochs.set(workspace, (this.epochs.get(workspace) ?? 0) + 1);
        for (const [key, lane] of this.tails) {
            if (lane.workspace === workspace) this.tails.delete(key);
        }
    }
}
