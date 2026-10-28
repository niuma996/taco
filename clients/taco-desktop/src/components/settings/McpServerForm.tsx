/**
 * McpServerForm — add or edit an MCP server entry.
 *
 * Edit mode receives the FULL `McpServerConfig` (fetched via mcp.getConfig) so
 * the sensitive fields it does not surface (env/headers/url) are preserved on
 * save. onSave returns a full `McpServerConfig` — the caller creates a new
 * server with it (mcp.createConfig) or sends it as a field-wise update patch
 * (mcp.updateConfig; the server merges, so untouched fields survive).
 */
import type { McpServerConfig, McpTransportKind } from "@taco-ai/protocol";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

const TRANSPORT_OPTIONS: ReadonlyArray<{ value: McpTransportKind; labelKey: string }> = [
    { value: "stdio", labelKey: "settings.mcpServerTransportStdio" },
    { value: "http", labelKey: "settings.mcpServerTransportHttp" },
];

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface McpServerFormProps {
    /** Edit mode (existing server) or new (id must not be provided). */
    existing?: McpServerConfig;
    /** Existing id list — new ids must not collide. */
    existingIds: ReadonlyArray<string>;
    /** While saving, both action buttons are disabled to prevent double submits. */
    saving?: boolean;
    onSave: (cfg: McpServerConfig) => void;
    onCancel: () => void;
}

export function McpServerForm(props: McpServerFormProps) {
    const { t } = useT();
    const isEdit = props.existing !== undefined;

    const [id, setId] = useState(props.existing?.id ?? "");
    const [transport, setTransport] = useState<McpTransportKind>(
        props.existing?.transport ?? "stdio",
    );
    const [command, setCommand] = useState(props.existing?.command ?? "");
    const [args, setArgs] = useState((props.existing?.args ?? []).join("\n"));
    const [env, setEnv] = useState(
        Object.entries(props.existing?.env ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
    );
    const [cwd, setCwd] = useState(props.existing?.cwd ?? "");
    const [url, setUrl] = useState(props.existing?.url ?? "");
    const [headers, setHeaders] = useState(
        Object.entries(props.existing?.headers ?? {})
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
    );
    const [timeoutMs, setTimeoutMs] = useState(
        props.existing?.timeoutMs !== undefined ? String(props.existing.timeoutMs) : "",
    );
    const [alwaysLoaded, setAlwaysLoaded] = useState(
        (props.existing?.alwaysLoaded ?? []).join("\n"),
    );

    const trimmedId = id.trim();
    const trimmedCommand = command.trim();
    const trimmedCwd = cwd.trim();
    const trimmedUrl = url.trim();

    const idClash = !isEdit && trimmedId !== "" && props.existingIds.includes(trimmedId);
    const idValid = trimmedId === "" || ID_PATTERN.test(trimmedId);

    // http URL must be a valid URL the sidecar's validateMcpServers will accept.
    let urlValid = true;
    if (transport === "http" && trimmedUrl !== "") {
        try {
            const parsed = new URL(trimmedUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") urlValid = false;
        } catch {
            urlValid = false;
        }
    }

    const timeoutInt = timeoutMs === "" ? NaN : Number.parseInt(timeoutMs, 10);
    const timeoutValid = timeoutMs === "" || (!Number.isNaN(timeoutInt) && timeoutInt > 0);
    const canSave =
        trimmedId !== "" &&
        !idClash &&
        idValid &&
        (transport === "stdio" ? trimmedCommand !== "" : trimmedUrl !== "") &&
        urlValid &&
        timeoutValid;

    const save = () => {
        if (!canSave) return;
        const cfg: McpServerConfig = {
            id: trimmedId,
            transport,
            command: transport === "stdio" ? trimmedCommand : undefined,
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
            cwd: transport === "stdio" && trimmedCwd !== "" ? trimmedCwd : undefined,
            url: transport === "http" ? trimmedUrl : undefined,
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
        props.onSave(cfg);
    };

    return (
        <Modal
            open
            onClose={props.onCancel}
            title={isEdit ? t("settings.mcpServerEdit") : t("settings.mcpServerAdd")}
            className="mcp-server-modal"
            actions={
                <>
                    <Button variant="ghost" onClick={props.onCancel} disabled={props.saving}>
                        {t("settings.mcpServerCancel")}
                    </Button>
                    <Button variant="primary" disabled={!canSave || props.saving} onClick={save}>
                        {props.saving ? t("settings.mcpServerSaving") : t("settings.mcpServerSave")}
                    </Button>
                </>
            }
        >
            <FormField
                label={t("settings.mcpServerId")}
                error={
                    idClash
                        ? t("settings.mcpServerIdClash")
                        : idValid
                          ? undefined
                          : t("settings.mcpServerIdInvalid")
                }
            >
                <TextInput
                    type="text"
                    value={id}
                    placeholder="e.g. github, filesystem"
                    disabled={isEdit}
                    onChange={(e) => setId(e.target.value)}
                />
            </FormField>

            <FormField label={t("settings.mcpServerTransport")}>
                <Select
                    value={transport}
                    onValueChange={(v) => setTransport(v as McpTransportKind)}
                    options={TRANSPORT_OPTIONS.map((o) => ({
                        value: o.value,
                        label: t(o.labelKey),
                    }))}
                    label={t("settings.mcpServerTransport")}
                />
            </FormField>

            {transport === "stdio" && (
                <>
                    <FormField
                        label={t("settings.mcpServerCommand")}
                        hint={t("settings.mcpServerCommandHint")}
                    >
                        <TextInput
                            type="text"
                            value={command}
                            placeholder="npx, /usr/local/bin/my-server, …"
                            onChange={(e) => setCommand(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerArgs")}
                        hint={t("settings.mcpServerArgsHint")}
                    >
                        <Textarea
                            value={args}
                            rows={3}
                            placeholder="--flag value\n--option key=value"
                            onChange={(e) => setArgs(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerEnv")}
                        hint={t("settings.mcpServerEnvHint")}
                    >
                        <Textarea
                            value={env}
                            rows={3}
                            placeholder="API_KEY=sk-…\nDEBUG=true"
                            onChange={(e) => setEnv(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerCwd")}
                        hint={t("settings.mcpServerCwdHint")}
                    >
                        <TextInput
                            type="text"
                            value={cwd}
                            placeholder={t("settings.mcpServerCwdPlaceholder")}
                            onChange={(e) => setCwd(e.target.value)}
                        />
                    </FormField>
                </>
            )}

            {transport === "http" && (
                <>
                    <FormField
                        label={t("settings.mcpServerUrl")}
                        error={urlValid ? undefined : t("settings.mcpServerUrlInvalid")}
                    >
                        <TextInput
                            type="text"
                            value={url}
                            placeholder="https://my-mcp-server.example.com/mcp"
                            onChange={(e) => setUrl(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerHeaders")}
                        hint={t("settings.mcpServerHeadersHint")}
                    >
                        <Textarea
                            value={headers}
                            rows={3}
                            placeholder="Authorization: Bearer sk-…\nX-Custom-Header: value"
                            onChange={(e) => setHeaders(e.target.value)}
                        />
                    </FormField>
                </>
            )}

            <FormField
                label={t("settings.mcpServerTimeout")}
                hint={t("settings.mcpServerTimeoutHint")}
            >
                <TextInput
                    type="text"
                    value={timeoutMs}
                    placeholder="15000"
                    onChange={(e) => setTimeoutMs(e.target.value)}
                />
            </FormField>

            <FormField
                label={t("settings.mcpServerAlwaysLoaded")}
                hint={t("settings.mcpServerAlwaysLoadedHint")}
            >
                <Textarea
                    value={alwaysLoaded}
                    rows={3}
                    placeholder={t("settings.mcpServerAlwaysLoadedPlaceholder")}
                    onChange={(e) => setAlwaysLoaded(e.target.value)}
                />
            </FormField>
        </Modal>
    );
}
