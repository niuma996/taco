import { createLogger } from "../lib/logger.ts";
import { type DeliveryClock, systemClock } from "./workDelivery.ts";

const log = createLogger("sidecar.work.maintenance");

export const WORK_MAINTENANCE_INTERVAL_MS = 60_000;

/** Runs serial maintenance passes; stopping also fences an in-flight pass from rearming. */
export class WorkMaintenance {
    private cancelTimer?: () => void;
    private generation = 0;
    private started = false;
    private running?: Promise<void>;

    constructor(
        private readonly maintain: () => Promise<unknown>,
        private readonly clock: DeliveryClock = systemClock,
    ) {}

    start(): void {
        if (this.started) return;
        this.started = true;
        this.schedule(++this.generation);
    }

    stop(): void {
        this.started = false;
        this.generation++;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
    }

    private schedule(generation: number): void {
        this.cancelTimer = this.clock.setTimer(() => {
            this.cancelTimer = undefined;
            void this.tick(generation);
        }, WORK_MAINTENANCE_INTERVAL_MS);
    }

    private async tick(generation: number): Promise<void> {
        if (!this.started || generation !== this.generation) return;
        this.running ??= Promise.resolve()
            .then(() => this.maintain())
            .then(() => undefined)
            .catch((error: unknown) => {
                log.error("work maintenance failed", { error: String(error) });
            });
        const running = this.running;
        await running;
        if (this.running === running) this.running = undefined;
        if (this.started && generation === this.generation) this.schedule(generation);
    }
}
