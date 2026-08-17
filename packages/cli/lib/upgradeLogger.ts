/**
 * Tiny stderr logger so the upgrade flow doesn't need to depend on the
 * sidecar's full `createLogger` (which pulls in the rest of the sidecar's
 * runtime). Single-process CLI tool, no need for structured output.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string): void {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [${level}] [${scope}] ${msg}\n`);
}

export interface UpgradeLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

export function createLogger(scope: string): UpgradeLogger {
    return {
        info(msg) {
            emit("info", scope, msg);
        },
        warn(msg) {
            emit("warn", scope, msg);
        },
        error(msg) {
            emit("error", scope, msg);
        },
    };
}
