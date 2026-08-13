/**
 * Builtin project-manifest extension. Injects a single hidden `<project_manifests>`
 * tag listing the root-level manifest files detected in the workspace, so the model
 * can see the language stack and package manager without having to glob for them.
 *
 * Glob patterns (rather than exact filenames) so the detector handles families
 * with multiple conventions — `build.gradle` and `build.gradle.kts` for the JVM
 * Gradle family, `*.csproj` / `*.sln` for .NET, etc.
 *
 * The tag is `pin`-compressed: it survives compaction so the model doesn't lose
 * the stack signal after context truncation. Filenames only — never the files'
 * contents (a manifest may embed secrets).
 *
 * Silently no-ops when no manifest matches, when the workspace lacks read access,
 * or on IM/third-party channels (the activator is short-circuited in
 * `extensions/activation.ts` so the tag never reaches the remote platform).
 *
 * Disable via `disabledExtensions: ["@taco/builtin-project-manifest"]` in
 * ~/.taco/taco.json.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import fg from "fast-glob";
import ignore from "ignore";
import { createUserMessage, tagWrap } from "../../../tags/builder.ts";
import type { TagSpec } from "../../../tags/types.ts";
import { MANIFEST_SAFE_DEFAULT_IGNORES } from "../../../tools/safeDefaults.ts";
import type { BuiltinManifest } from "../../builtinContract.ts";
import type { ContextHook, WorkspaceActivator } from "../../types.ts";

const TAG_NAME = "project_manifests";
const BUILTIN_NAME = "@taco/builtin-project-manifest";

const TAG_SPEC: TagSpec = {
    name: TAG_NAME,
    scope: "user-context",
    compression: { kind: "pin" },
    tuiVisibility: "hidden",
    parser: { kind: "xml-balanced" },
    description: "Detected root-level manifest filenames for the project's language stack",
};

/**
 * Glob patterns for well-known root-level manifests. Glob (rather than exact
 * filename match) so families with multiple conventions — Gradle's `.gradle` /
 * `.gradle.kts`, .NET's `*.csproj` / `*.sln` — are covered uniformly.
 *
 * Adding a new ecosystem means adding one or two lines here. There is no
 * "core" notion of which languages the sidecar supports; this list is one
 * builtin extension's opinion, and can be replaced by a different extension
 * that ships its own patterns.
 */
const MANIFEST_PATTERNS: ReadonlyArray<string> = [
    // Node / JS
    "package.json",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "package-lock.json",
    // Rust / Go
    "Cargo.toml",
    "go.mod",
    // Python
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "poetry.lock",
    "uv.lock",
    // JVM
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    // PHP / Ruby
    "composer.json",
    "Gemfile",
    // .NET
    "*.csproj",
    "*.sln",
    // C / C++
    "CMakeLists.txt",
    "Makefile",
    // Swift
    "Package.swift",
    // Dart / Flutter
    "pubspec.yaml",
    // Elixir
    "mix.exs",
    // Nix
    "flake.nix",
];

/** fast-glob minimatch ignores — keep results sane on monorepos. */
const SAFE_DEFAULT_IGNORES = MANIFEST_SAFE_DEFAULT_IGNORES;

/** Inline guidance rendered into the tag body so the model knows how to use the list. */
const TAG_GUIDANCE =
    "Detected manifest filenames at the workspace root. Use this to choose the " +
    "right tooling (e.g. read `package.json` for npm scripts, `pyproject.toml` " +
    "for Python entry points) without globbing for it first. Do NOT fetch the " +
    "files' contents unprompted — manifests may embed secrets.";

/**
 * Read `.gitignore` if present and return its compiled ignore matcher. Used to
 * suppress manifest matches that the repo itself has excluded from version
 * control (rare but possible when the manifest is generated). Returns a no-op
 * matcher when `.gitignore` is absent or unreadable.
 */
function gitignoreMatcher(cwd: string): ReturnType<typeof ignore> {
    try {
        const raw = readFileSync(join(cwd, ".gitignore"), "utf8");
        return ignore().add(raw);
    } catch {
        return ignore();
    }
}

/**
 * Probe `cwd` once for matching root manifests. Returns filenames relative to
 * `cwd`, sorted alphabetically, with duplicates removed (e.g. `*.csproj` might
 * match both the project file and its shared props file; we surface both
 * because both are useful).
 */
async function detectManifests(cwd: string): Promise<ReadonlyArray<string>> {
    const matches = await fg(MANIFEST_PATTERNS as string[], {
        cwd,
        dot: false,
        followSymbolicLinks: false,
        onlyFiles: true,
        suppressErrors: true,
        ignore: SAFE_DEFAULT_IGNORES,
    });
    const matcher = gitignoreMatcher(cwd);
    return [...new Set(matches.filter((rel) => !matcher.ignores(rel)))].sort();
}

/** Build the tag body from detected manifests. */
function formatManifests(filenames: ReadonlyArray<string>): string {
    const lines = [TAG_GUIDANCE, "", ...filenames.map((f) => `- ${f}`)];
    return lines.join("\n");
}

/**
 * Context hook factory bound to a specific `cwd`.
 *
 * Probes on first invocation and caches the result per-cwd. Returns `undefined`
 * when no manifest is detected (the activator already short-circuits IM
 * workspaces, so this hook only ever runs in the local-channel path).
 */
export function buildProjectManifestsHook(cwd: string): ContextHook {
    let probed = false;
    let manifests: ReadonlyArray<string> = [];

    return async (event: ContextEvent): Promise<ContextResult | undefined> => {
        if (!probed) {
            manifests = await detectManifests(cwd);
            probed = true;
        }
        if (manifests.length === 0) return undefined;

        const tag: AgentMessage = createUserMessage(tagWrap(TAG_NAME, formatManifests(manifests)));
        return { messages: [tag, ...event.messages] };
    };
}

/** Workspace activator — runs the probe async, returns hooks if anything matched. */
export function buildProjectManifestsActivator(): WorkspaceActivator {
    return async (ctx) => {
        const manifests = await detectManifests(ctx.cwd);
        if (manifests.length === 0) return undefined;
        return { contextHooks: [buildProjectManifestsHook(ctx.cwd)] };
    };
}

/** Get the tag spec — exposed so the loader can register it. */
export function getProjectManifestsTagSpec(): TagSpec {
    return TAG_SPEC;
}

/** Builtin manifest — self-describes metadata, tag spec, and workspace activator. */
export const manifest: BuiltinManifest = {
    name: BUILTIN_NAME,
    description:
        "Injects a hidden <project_manifests> tag listing detected root-level manifest filenames (package.json, Cargo.toml, etc.) so the model can recognize the language stack and package manager. Survives compaction. Silently no-ops when no manifest is detected. Always disabled on IM/third-party channels (see extensions/activation.ts).",
    whenToUse:
        "Built-in. Disable via `disabledExtensions` in ~/.taco/taco.json if you don't want manifest filenames surfaced.",
    register: (registry) => {
        registry.addExtensionTag(BUILTIN_NAME, TAG_SPEC.name, TAG_SPEC);
    },
    activator: buildProjectManifestsActivator,
};
