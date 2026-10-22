---
name: taco-configure
description: Use when modifying taco configuration — creating or installing skills or agents, editing $TACO_HOME/taco.json (default model, providers, channels, MCP servers, instructions, command permissions), or downloading remote skills. For skill authoring alone, prefer the `create-skill` skill.
metadata:
  version: "1.1.0"
---

# Configuring taco

`create-skill` covers skill authoring in depth. This skill is the umbrella for everything else: skill install from a URL, agent authoring, and patches to the global config. Reach for it when the ask crosses more than one of those surfaces, or when the change touches global state rather than a single SKILL.md.

## Read first

Before writing anything, find out what's already there. State lives in three places:

- **Skills and agents** — read the directories directly. `$TACO_HOME/skills/`, `~/.claude/skills/`, `~/.pi/skills/`, `<cwd>/.taco/skills/`, and `<sidecar>/skills/builtin/` (read-only — never write here). Same set under `agents/` instead of `skills/`.
- **Global config** — read it with the `configGet` tool (see below).
- **Desktop settings panes** — channel bindings and MCP servers live partly in the config file and partly in the desktop app's binding state. The file is what the sidecar loads; the UI may have secrets in memory not yet written back.
## Global config: use the config tools

Two deferred tools, not the filesystem:

```
addTools("configGet")     → read the current config (secrets come back masked)
addTools("configPatch")   → change it (the user approves each change)
```

Load them with `addTools` first — they are not resident, so they are not in the tool list until then. Both work only in a local desktop session: unavailable in an IM conversation, and in a subagent.

`configGet` masks every secret: API keys show as "configured" but never their value; MCP `env`/`headers`/`command`/`args`/`url` and channel `config` are omitted. A stored key can be confirmed present, never read back. Never read `~/.taco/taco.json` with the `read` tool — it holds API keys in plaintext, and reading it puts them in the conversation.

`configPatch` takes a `patch` with only the fields to change; the rest keep their value. The user sees a prompt listing the changed fields and must approve before anything is written. The `allow` / `deny` arrays are **replaced wholesale**, not merged — send the complete list. Schema: `TacoGlobalConfigShape` in `packages/protocol/src/config.ts`.

Accepted fields:

- `defaultModel` / `defaultProvider` — single strings; no restart needed if hot-reload picks it up.
- `systemPrompt` — free text. Quote carefully if it contains newlines or colons.
- `thinkingLevel` — `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`.
- `compaction` — `{ enabled, threshold }` with threshold in 0–1.
- `commandPermissions` — `{ mode: "ask" | "auto", allow?: string[], deny?: string[] }`. Glob patterns; deny wins and asks. Unmatched commands ask in `ask`, pass in `auto`. Built-in high-risk commands, parse failures and unauthorized `cd` always ask.
- `instructions` — `{ enabled: boolean, files: { claudeMd?: boolean, agentsMd?: boolean, designMd?: boolean }, inheritToSubagents: boolean }`.

**Secrets cannot be set through these tools.** `configPatch` rejects API keys, MCP servers, and channels, because their secret fields are masked on read and a partial write would erase them. When the ask involves one of those — `customProviders` (array of `{ id, name, api, baseUrl, models: [{ id }] }`, `api` is `"chatcomplete"` for OpenAI-compatible endpoints), `mcpServers` (array of `{ id, transport, enabled, command?, args?, url?, env?, alwaysLoaded? }`, `transport` is `"stdio" | "http"`, `alwaysLoaded` lists tool names always in the toolset), or `channels` (array of `{ channelId, manifest: { name, version }, config }`, `channelId` must match `/^[a-z0-9][a-z0-9-]*$/`, credentials live separately at `$TACO_HOME/channels/<channelId>.json`) — stop and point the user at the desktop settings pane. That path writes the secret without echoing it back.

## Skills: directory choice

Four user-writable directories in priority order (first match by name wins):

1. `<cwd>/.taco/skills/` — project-local
2. `$TACO_HOME/skills/` (default `~/.taco/skills/`) — global
3. `~/.claude/skills/`
4. `~/.pi/skills/`

Default to **global** (option 2) when the user hasn't specified. Use `askUser` with `scope` as the header when ambiguous — Global first, Project-local second. Never write to `<sidecar>/skills/builtin/` — it ships with taco and is overwritten by upgrades.

`write` reaches the workspace and `$TACO_HOME/{skills,agents}/` (local only); elsewhere needs user-approved `shell`. New skills only show up in `<available_skills>` after a new session (the system prompt is frozen at boot); the directory itself hot-reloads in ~300ms. For body composition, frontmatter keys, scripts-vs-body tradeoffs, and `runAs` / `inlineOnly` choices, defer to the `create-skill` skill.

## Agents: directory choice and layout

Agents live in `*.md` files in one of four user-writable directories (last-wins overwrites by name — opposite of skills):

1. `~/.claude/agents/`
2. `~/.pi/agents/`
3. `$TACO_HOME/agents/` (default `~/.taco/agents/`)
4. `<cwd>/.taco/agents/` — highest priority; project-local wins

Default to **global** (option 3) for personal agents. Use project-local only when the agent is bound to this repo's conventions. Use `askUser` with `scope` as the header when ambiguous — Global first, Project-local second. In an IM conversation there is no project directory, so write global only. File name should match the `name` frontmatter so it's greppable.

A project-local agent shadows a global one of the same name for this workspace only; check both directories first and tell the user when a copy would be shadowed.

Frontmatter (all keys taco reads; pi loads with these but ignores unknowns): `name`, `description`, `whenToUse`, `tools` (a whitelist of tool names), `maxTurns`, `context` (`independent`, or `fork` to give the subagent this conversation's transcript), `runtime`, `permissionMode`, `cwd`, and `fewShots` — a YAML list of `{ user, assistant }` pairs injected ahead of the body to demonstrate the contract.

`name` and `description` are required; `whenToUse` is preferred over `description` — the `agent` tool's hint block surfaces `whenToUse` when the model is choosing a subagent.

A `runtime: claude-code` agent takes `cwd`: the absolute directory it always runs in, fixed when the definition is written. Pick the workspace directory or one of its associated directories, and ask the user which one when it is not obvious. Omitted = the calling workspace's directory. The path applies from every workspace that calls the agent, so a global agent with a `cwd` sends every caller — IM conversations included — into that directory; say so to the user before writing one.

## Remote skill install

The user points at a URL. Three shapes: a public GitHub repo with a top-level `SKILL.md` (`git clone --depth 1`, then move `SKILL.md` into `<target>/<repoName>/`), a path inside a repo (fetch the tarball with `curl -L | tar -xz -C <staging>`, copy the named directory), or a bare tarball or git URL (same flow, treat the unpacked root as the candidate).

Stage into `mktemp -d` to keep the workspace clean, then copy just the skill directory into the target. Validate `name` + `description` in frontmatter before writing. If a higher-priority directory already has a skill with the same `name`, warn — first-wins means the new copy will be shadowed.

Ask for the target directory with the same `scope` question used for local creation.

## The loop

1. Read what's there — the config via `configGet`, the candidate skill/agent directories, any same-named entry that would be shadowed.
2. Confirm scope and target with `askUser` when ambiguous — no narration.
3. Make the change. Skills/agents: write the file. Config: `configPatch`. Remote install: stage, validate, copy.
4. Verify on a new session. Tell the user to start one before reporting a regression.
5. If something doesn't load, read the sidecar log or ask what the SkillsPane diagnostics show — a missing or empty `description` is the most common reason a skill silently fails to load.
