/**
 * ToolsPane — tool list panel (shown when mainView = 'tools').
 *
 * Left: searchable/filterable list showing only tool names. Right: detail with
 * category/loading/subagent tags and a shiki-highlighted JSON schema inside a
 * fixed-height scrollable frame. Data is passed via props; the parent fetches
 * from the sidecar.
 */

import rehypeShiki from "@shikijs/rehype";
import type { ToolEntry } from "@taco-ai/protocol";
import { useMemo, useState } from "react";
import { MarkdownHooks as ReactMarkdown } from "react-markdown";

import { Select } from "../components/ui/Select";
import { TextInput } from "../components/ui/TextInput";
import { useT } from "../i18n/useI18n";

export interface ToolsPaneProps {
    tools: ToolEntry[];
}

interface SubagentTagProps {
    available: boolean | undefined;
    label: (key: string) => string;
}

function SubagentTag({ available, label }: SubagentTagProps) {
    if (available === undefined) return null;
    return (
        <span
            className={`tools-list-tag ${available ? "tag-subagent-ok" : "tag-subagent-no"}`}
            title={
                available
                    ? "Available in sub-agent (depth=1)"
                    : "Filtered out in sub-agent (depth=1)"
            }
        >
            {available ? label("tools.subagentAvailable") : label("tools.subagentUnavailable")}
        </span>
    );
}

interface LoadingTagProps {
    loading: ToolEntry["loading"];
    label: (key: string) => string;
}

// Renders only when the tool has a `loading` flag — i.e. it came from the
// deferred-tool registry (MCP) or is a session meta-tool. Static tools leave
// this slot empty so the detail header isn't visually noisier than before.
function LoadingTag({ loading, label }: LoadingTagProps) {
    if (loading === undefined) return null;
    const isAlways = loading === "always";
    return (
        <span
            className={`tools-list-tag ${isAlways ? "tag-loading-always" : "tag-loading-deferred"}`}
            title={isAlways ? label("tools.loadingAlwaysHint") : label("tools.loadingDeferredHint")}
        >
            {isAlways ? label("tools.loadingAlways") : label("tools.loadingDeferred")}
        </span>
    );
}

interface CategoryTagProps {
    category: ToolEntry["category"];
    label: (key: string) => string;
}

function categoryTagClass(category: ToolEntry["category"]): string {
    if (category === "builtin") return "tag-builtin";
    if (category === "external") return "tag-external";
    if (category === "mcp") return "tag-mcp";
    return "tag-session";
}

function categoryLabelKey(category: ToolEntry["category"]): string {
    if (category === "builtin") return "tools.categoryBuiltin";
    if (category === "external") return "tools.categoryExtension";
    if (category === "mcp") return "tools.categoryMcp";
    return "tools.categorySession";
}

function CategoryTag({ category, label }: CategoryTagProps) {
    return (
        <span className={`tools-list-tag ${categoryTagClass(category)}`}>
            {label(categoryLabelKey(category))}
        </span>
    );
}

type SourceFilter = "all" | ToolEntry["category"];
type TriFilter = "all" | "yes" | "no";
type LoadingFilter = "all" | "always" | "deferred";

export function ToolsPane({ tools }: ToolsPaneProps) {
    const { t } = useT();
    // `userPick` tracks the user's explicit selection. When unset (or pointing
    // at a tool no longer in the list) we fall back to the first tool so the
    // detail pane renders immediately on first async fetch, instead of staying
    // on the placeholder.
    const [userPick, setUserPick] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [source, setSource] = useState<SourceFilter>("all");
    const [subagent, setSubagent] = useState<TriFilter>("all");
    const [loading, setLoading] = useState<LoadingFilter>("all");

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return tools.filter((tool) => {
            if (q && !`${tool.name} ${tool.label}`.toLowerCase().includes(q)) return false;
            if (source !== "all" && tool.category !== source) return false;
            // `availableInSubagent === undefined` means the workspace has no
            // agent configuration at all — there's no whitelist to evaluate
            // against. Treat it the same as "explicitly unavailable" so the
            // filter doesn't silently empty the list when no agents are set.
            const reachable = tool.availableInSubagent;
            if (subagent === "yes" && reachable !== true) return false;
            if (subagent === "no" && reachable === true) return false;
            if (loading !== "all" && tool.loading !== loading) return false;
            return true;
        });
    }, [tools, query, source, subagent, loading]);

    const selected = userPick ?? filtered[0]?.name ?? null;
    const selectedTool = tools.find((tool) => tool.name === selected) ?? null;

    return (
        <div className="tools-pane">
            <div className="tools-list">
                <div className="pane-header">
                    <span>
                        {t("activity.tools")} ({filtered.length})
                    </span>
                </div>
                <div className="tools-list-controls">
                    <TextInput
                        className="tools-search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t("tools.searchPlaceholder")}
                        aria-label={t("tools.searchPlaceholder")}
                    />
                    <div className="tools-filters">
                        <div className="tools-filter">
                            <span className="tools-filter-label">{t("tools.filterSource")}</span>
                            <Select
                                value={source}
                                onValueChange={(v) => setSource(v as SourceFilter)}
                                label={t("tools.filterSource")}
                                options={[
                                    { value: "all", label: t("tools.filterAll") },
                                    { value: "builtin", label: t("tools.categoryBuiltin") },
                                    { value: "external", label: t("tools.categoryExtension") },
                                    { value: "mcp", label: t("tools.categoryMcp") },
                                    { value: "session", label: t("tools.categorySession") },
                                ]}
                            />
                        </div>
                        <div className="tools-filter">
                            <span className="tools-filter-label">{t("tools.filterSubagent")}</span>
                            <Select
                                value={subagent}
                                onValueChange={(v) => setSubagent(v as TriFilter)}
                                label={t("tools.filterSubagent")}
                                options={[
                                    { value: "all", label: t("tools.filterAll") },
                                    { value: "yes", label: t("tools.subagentAvailable") },
                                    { value: "no", label: t("tools.subagentUnavailable") },
                                ]}
                            />
                        </div>
                        <div className="tools-filter">
                            <span className="tools-filter-label">{t("tools.filterLoading")}</span>
                            <Select
                                value={loading}
                                onValueChange={(v) => setLoading(v as LoadingFilter)}
                                label={t("tools.filterLoading")}
                                options={[
                                    { value: "all", label: t("tools.filterAll") },
                                    { value: "always", label: t("tools.loadingAlways") },
                                    { value: "deferred", label: t("tools.loadingDeferred") },
                                ]}
                            />
                        </div>
                    </div>
                </div>
                {filtered.length === 0 ? (
                    <div className="tools-list-empty">{t("tools.noMatch")}</div>
                ) : (
                    filtered.map((tool) => (
                        <button
                            key={tool.name}
                            type="button"
                            className={`tools-list-item${selected === tool.name ? " active" : ""}`}
                            onClick={() => setUserPick(tool.name)}
                            title={tool.name}
                        >
                            <span className="tools-list-label">{tool.label}</span>
                        </button>
                    ))
                )}
            </div>
            <div className="tools-detail">
                {!selectedTool ? (
                    <div className="tools-detail-placeholder">{t("tools.selectToView")}</div>
                ) : (
                    <>
                        <h2 className="tools-detail-name">{selectedTool.name}</h2>
                        <p className="tools-detail-meta">
                            <CategoryTag category={selectedTool.category} label={t} />
                            <LoadingTag loading={selectedTool.loading} label={t} />
                            <SubagentTag available={selectedTool.availableInSubagent} label={t} />
                        </p>
                        <p className="tools-detail-description" title={selectedTool.description}>
                            {selectedTool.description || t("tools.noDescription")}
                        </p>
                        {selectedTool.inputSchema ? (
                            <>
                                <div className="tools-detail-schema-label">
                                    {t("tools.schemaLabel")}
                                </div>
                                <div className="tools-detail-schema md-code-block">
                                    <ReactMarkdown
                                        rehypePlugins={[
                                            [
                                                rehypeShiki,
                                                {
                                                    themes: {
                                                        light: "github-light",
                                                        dark: "github-dark",
                                                    },
                                                    defaultColor: false,
                                                },
                                            ],
                                        ]}
                                        fallback={null}
                                    >
                                        {`\`\`\`json\n${JSON.stringify(selectedTool.inputSchema, null, 2)}\n\`\`\``}
                                    </ReactMarkdown>
                                </div>
                            </>
                        ) : (
                            <p className="tools-detail-empty">{t("tools.noSchema")}</p>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
