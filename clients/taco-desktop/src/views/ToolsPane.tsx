/**
 * ToolsPane — tool list panel (shown when mainView = 'tools').
 *
 * Left: searchable tool cards with source, subagent, and loading filters.
 * Right: tool metadata and a wrapping, highlighted JSON schema that fills the
 * remaining detail height. Data is passed via props; the parent fetches it.
 */

import rehypeShiki from "@shikijs/rehype";
import type { ToolEntry } from "@taco-ai/protocol";
import { type KeyboardEvent, useMemo, useState } from "react";
import { MarkdownHooks as ReactMarkdown } from "react-markdown";

import { PaneHeader } from "../components/PaneHeader";
import { useT } from "../i18n/useI18n";

export interface ToolsPaneProps {
    tools: ToolEntry[];
    error: string | null;
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

function FilterChips<T extends string>({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: T;
    onChange: (value: T) => void;
    options: ReadonlyArray<{ value: T; label: string }>;
}) {
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const step =
            event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
        const currentIndex = options.findIndex((option) => option.value === value);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : step === 0
                    ? -1
                    : (currentIndex + step + options.length) % options.length;
        if (index < 0) return;
        event.preventDefault();
        const next = options[index];
        if (!next) return;
        onChange(next.value);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[index]?.focus();
    };

    return (
        <div className="tools-filter">
            <span className="tools-filter-label">{label}</span>
            <div
                className="tools-filter-chips"
                role="radiogroup"
                aria-label={label}
                onKeyDown={handleKeyDown}
            >
                {options.map((option) => (
                    // biome-ignore lint/a11y/useSemanticElements: pill buttons follow the memory pane's radio-group pattern with roving focus and arrow navigation
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={value === option.value}
                        tabIndex={value === option.value ? 0 : -1}
                        className="tools-filter-chip"
                        onClick={() => onChange(option.value)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

export function ToolsPane({ tools, error }: ToolsPaneProps) {
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
                <PaneHeader
                    title={t("activity.tools")}
                    count={tools.length}
                    shownCount={filtered.length}
                    query={query}
                    onQueryChange={setQuery}
                />
                {error && (
                    <div className="error-banner" role="alert">
                        {error}
                    </div>
                )}
                <div className="tools-list-controls">
                    <div className="tools-filters">
                        <FilterChips
                            label={t("tools.filterSource")}
                            value={source}
                            onChange={setSource}
                            options={[
                                { value: "all", label: t("tools.filterAll") },
                                { value: "builtin", label: t("tools.categoryBuiltin") },
                                { value: "external", label: t("tools.categoryExtension") },
                                { value: "mcp", label: t("tools.categoryMcp") },
                                { value: "session", label: t("tools.categorySession") },
                            ]}
                        />
                        <FilterChips
                            label={t("tools.filterSubagent")}
                            value={subagent}
                            onChange={setSubagent}
                            options={[
                                { value: "all", label: t("tools.filterAll") },
                                { value: "yes", label: t("tools.subagentAvailable") },
                                { value: "no", label: t("tools.subagentUnavailable") },
                            ]}
                        />
                        <FilterChips
                            label={t("tools.filterLoading")}
                            value={loading}
                            onChange={setLoading}
                            options={[
                                { value: "all", label: t("tools.filterAll") },
                                { value: "always", label: t("tools.loadingAlways") },
                                { value: "deferred", label: t("tools.loadingDeferred") },
                            ]}
                        />
                    </div>
                </div>
                <div className="tools-list-body">
                    {filtered.length === 0 ? (
                        <div className="ui-empty">{t("tools.noMatch")}</div>
                    ) : (
                        <div className="tools-card-grid">
                            {filtered.map((tool) => (
                                <button
                                    key={tool.name}
                                    type="button"
                                    className={`tools-list-item${selected === tool.name ? " active" : ""}`}
                                    onClick={() => setUserPick(tool.name)}
                                    title={tool.name}
                                >
                                    <span className="tools-list-label">{tool.label}</span>
                                    <span className="tools-list-item-description">
                                        {tool.description || t("tools.noDescription")}
                                    </span>
                                    <span className="tools-list-item-meta">
                                        <CategoryTag category={tool.category} label={t} />
                                        <LoadingTag loading={tool.loading} label={t} />
                                        <SubagentTag
                                            available={tool.availableInSubagent}
                                            label={t}
                                        />
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
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
                                <div className="tools-detail-schema tools-detail-schema--fill md-code-block">
                                    <ReactMarkdown
                                        rehypePlugins={[
                                            [
                                                rehypeShiki,
                                                {
                                                    themes: {
                                                        light: "material-theme-lighter",
                                                        dark: "material-theme-ocean",
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
