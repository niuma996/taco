---
name: taco-configure
description: Use when modifying taco configuration — creating or installing skills or agents, editing $TACO_HOME/taco.json (default model, providers, channels, MCP servers, instructions, command permissions), or downloading remote skills. For skill authoring alone, prefer the `create-skill` skill.
---

# Configuring taco

`create-skill` covers skill authoring in depth. This skill is the umbrella for everything else: skill install from a URL, agent authoring, and patches to the global config (`taco.json`). Reach for it when the user's ask crosses more than one of those surfaces, or when the change touches global state rather than a single SKILL.md.

## Read first

Before writing anything, find out what's already there. State lives in three places:

- **Skills and agents** — read the directories directly. `$TACO_HOME/skills/`, `~/.claude/skills/`, `~/.pi/skills/`, `<cwd>/.taco/skills/`, and `<sidecar>/skills/builtin/` (read-only — never write here). Same set under `agents/` instead of `skills/`.
- **Global config** — `~/.taco/taco.json` (or `$TACO_HOME/taco.json` when `TACO_HOME` is set). Read with the `read` tool before any patch.
- **Desktop settings panes** — channel bindings and MCP servers live partly in `taco.json` and partly in the desktop app's binding state. The file is what the sidecar loads; the UI may have secrets in memory not yet written back.

## Skills: directory choice

Four user-writable directories in priority order (first match by name wins):

1. `<cwd>/.taco/skills/` — project-local
2. `$TACO_HOME/skills/` (default `~/.taco/skills/`) — global
3. `~/.claude/skills/`
4. `~/.pi/skills/`

Default to **global** (option 2) when the user hasn't specified. Use `askUser` with `scope` as the header when ambiguous — Global first, Project-local second. Never write to `<sidecar>/skills/builtin/` — it ships with taco and is overwritten by upgrades.

New skills only show up in `<available_skills>` after a new session (the system prompt is frozen at boot); the directory itself hot-reloads in ~300ms. For body composition, frontmatter keys, scripts-vs-body tradeoffs, and `runAs` / `inlineOnly` choices, defer to the `create-skill` skill.

## Agents: directory choice and layout

Agents live in `*.md` files in one of four user-writable directories (last-wins overwrites by name — opposite of skills):

1. `~/.claude/agents/`
2. `~/.pi/agents/`
3. `$TACO_HOME/agents/` (default `~/.taco/agents/`)
4. `<cwd>/.taco/agents/` — highest priority; project-local wins

Default to **global** (option 3) for personal agents. Use project-local only when the agent is bound to this repo's conventions. File name should match the `name` frontmatter so it's greppable.

Frontmatter (all keys taco reads; pi loads with these but ignores unknowns):

```yaml
---
name: explorer
description: Read-only codebase search specialist.
whenToUse: "Use when the task is to find, search, locate, or trace code."
tools: [read, grep, glob, shell]
maxTurns: 30
context: independent   # or "fork" — gives the subagent this conversation's transcript
---
```

`fewShots` is also supported: a YAML list of `{ user, assistant }` pairs injected ahead of the body to demonstrate the contract. Required: `name`, `description`. `whenToUse` is preferred over `description` — `agent` tool's hint block surfaces `whenToUse` when the model is choosing a subagent.

## Remote skill install

The user points at a URL. Three common shapes:

- **A public GitHub repo with a top-level SKILL.md** — `git clone --depth 1 <url> <target>/<repoName>` then move `SKILL.md` into `<target>/<repoName>/`. Inspect the cloned tree first; the skill may live at the root or under `skills/<name>/`.
- **A path inside a repo** — `https://github.com/<owner>/<repo>/tree/<ref>/<path>` — fetch the tarball (`curl -L | tar -xz -C <staging>`) and copy only the named directory.
- **A bare tarball or git URL** — same flow, treat the unpacked root as the candidate.

Staging pattern that keeps the workspace clean: clone or fetch into `mktemp -d`, then copy just the skill directory into the target. Validate `name` + `description` in frontmatter before writing. If a higher-priority directory already has a skill with the same `name`, warn — first-wins means the new copy will be shadowed.

Ask the user for the target directory with the same `scope` question used for local creation. Once installed, mention the new-session caveat.

## Patching `$TACO_HOME/taco.json`

The file is JSON. Read it, build a partial object with only the changed fields, write back atomically (use `write` only after a full read — partial writes drop untouched fields). Permissions stay `0600`.

Schema: `TacoGlobalConfigShape` in `packages/protocol/src/config.ts`. The masked IPC view (`TacoGlobalConfigView`) strips `anthropicApiKey`, `openaiApiKey`, `apiKeys.*`, `mcpServers[i].{env,headers,command,args,url,cwd}`, and `channels[i].config` — disk keeps plaintext, only IPC frames mask.

Common patches:

- `defaultModel` / `defaultProvider` — single strings, no restart needed if hot-reload picks up (workspaces built before the change keep their construction-time fallback).
- `systemPrompt` — free text. Quote carefully if it contains newlines or colons.
- `thinkingLevel` — `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`.
- `compaction` — `{ enabled: boolean, threshold: number (0–1) }`.
- `customProviders` — array of `{ id, name, api, baseUrl, models: [{ id }] }`. `api` is `"chatcomplete"` for OpenAI-compatible endpoints.
- `mcpServers` — array of `{ id, transport, enabled, command?, args?, url?, env?, alwaysLoaded? }`. `transport` is `"stdio" | "http"`. `alwaysLoaded` is an array of tool names that should always be in the toolset (skip lazy discovery).
- `channels` — array of `{ channelId, manifest: { name, version }, config: Record<string, unknown> }`. `channelId` must match `/^[a-z0-9][a-z0-9-]*$/`. Channel credentials live separately at `$TACO_HOME/channels/<channelId>.json` under the SDK's own key — don't write secrets into `taco.json`.
- `commandPermissions` — `{ mode: "ask" | "allowlist", rules: string[] }`. Rules are glob-shaped patterns the sidecar evaluates against shell commands.
- `instructions` — `{ enabled: boolean, files: { claudeMd?: boolean, agentsMd?: boolean, designMd?: boolean }, inheritToSubagents: boolean }`.
- `extensions` / `disabledExtensions` — arrays of extension package names.

For any change involving an API key or channel secret: do not paste it into the chat. Either edit `taco.json` via the `read`/`write` tools in a single session (the file is `0600`), or instruct the user to use the Settings pane in the desktop app — that flow writes secrets through the masked path and never echoes them back.

## The loop

1. Read what's there — `~/.taco/taco.json`, the candidate skill/agent directories, any same-named entry that would be shadowed.
2. Confirm scope and target with `askUser` when ambiguous — no narration.
3. Make the change. Skills/agents: write the file. `taco.json`: read, patch in memory, write atomically. Remote install: stage, validate, copy.
4. Verify on a new session. Tell the user to start one before reporting a regression.
5. If something doesn't load, read the sidecar log or ask what the SkillsPane diagnostics show — a missing or empty `description` is the most common reason a skill silently fails to load.
