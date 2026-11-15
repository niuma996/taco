import type { McpServerConfig, McpTransportKind } from "@taco-ai/protocol";
import type { FieldErrors, Resolver } from "react-hook-form";

export interface McpServerDraft {
    id: string;
    transport: McpTransportKind;
    command: string;
    args: string;
    env: string;
    cwd: string;
    url: string;
    headers: string;
    timeoutMs: string;
    alwaysLoaded: string;
}

export function mcpServerDefaults(existing?: McpServerConfig): McpServerDraft {
    return {
        id: existing?.id ?? "",
        transport: existing?.transport ?? "stdio",
        command: existing?.command ?? "",
        args: (existing?.args ?? []).join("\n"),
        env: Object.entries(existing?.env ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
        cwd: existing?.cwd ?? "",
        url: existing?.url ?? "",
        headers: Object.entries(existing?.headers ?? {})
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
        timeoutMs: existing?.timeoutMs === undefined ? "" : String(existing.timeoutMs),
        alwaysLoaded: (existing?.alwaysLoaded ?? []).join("\n"),
    };
}

export function mcpServerResolver(
    existingIds: readonly string[],
    isEdit: boolean,
): Resolver<McpServerDraft> {
    return (values) => {
        const errors: FieldErrors<McpServerDraft> = {};
        const id = values.id.trim();
        if (!id) errors.id = { type: "required" };
        else if (!/^[a-zA-Z0-9_-]+$/.test(id)) errors.id = { type: "pattern" };
        else if (!isEdit && existingIds.includes(id)) errors.id = { type: "duplicate" };
        if (values.transport === "stdio") {
            if (!values.command.trim()) errors.command = { type: "required" };
        } else if (!values.url.trim()) errors.url = { type: "required" };
        else {
            try {
                if (!["http:", "https:"].includes(new URL(values.url.trim()).protocol))
                    throw new Error("protocol");
            } catch {
                errors.url = { type: "validate" };
            }
        }
        const timeout = Number.parseInt(values.timeoutMs, 10);
        if (values.timeoutMs !== "" && (Number.isNaN(timeout) || timeout <= 0))
            errors.timeoutMs = { type: "validate" };
        return Object.keys(errors).length ? { values: {}, errors } : { values, errors: {} };
    };
}

/** Inactive transport fields stay in the draft but are omitted from the RPC payload. */
export function mcpServerConfig(values: McpServerDraft): McpServerConfig {
    const { id, transport, command, args, env, cwd, url, headers, timeoutMs, alwaysLoaded } =
        values;
    return {
        id: id.trim(),
        transport,
        command: transport === "stdio" ? command.trim() : undefined,
        args:
            transport === "stdio" && args.trim() !== ""
                ? args
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean)
                : undefined,
        env:
            transport === "stdio" && env.trim() !== ""
                ? Object.fromEntries(
                      env
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((s) => {
                              const idx = s.indexOf("=");
                              return idx > 0 ? [s.slice(0, idx), s.slice(idx + 1)] : [s, ""];
                          }),
                  )
                : undefined,
        cwd: transport === "stdio" && cwd.trim() !== "" ? cwd.trim() : undefined,
        url: transport === "http" ? url.trim() : undefined,
        headers:
            transport === "http" && headers.trim() !== ""
                ? Object.fromEntries(
                      headers
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((s) => {
                              const idx = s.indexOf(":");
                              return idx > 0
                                  ? [s.slice(0, idx).trim(), s.slice(idx + 1).trim()]
                                  : [s, ""];
                          }),
                  )
                : undefined,
        timeoutMs: timeoutMs !== "" ? Number.parseInt(timeoutMs, 10) : undefined,
        alwaysLoaded:
            alwaysLoaded.trim() !== ""
                ? alwaysLoaded
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean)
                : undefined,
    };
}
