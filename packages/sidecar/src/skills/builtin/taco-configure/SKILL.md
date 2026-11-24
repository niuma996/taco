---
name: taco-configure
description: Use when changing the application's own setup — installing a skill from a URL, writing an agent definition, or editing the global config (default model, thinking level, system prompt, instructions, command permissions). For authoring a new skill from scratch, prefer the `create-skill` skill.
metadata:
  version: "1.2.0"
---

# Configuring the application

`create-skill` covers writing a skill from scratch. This skill covers the rest: installing a skill someone else wrote, defining agents, and patching the global config. Reach for it when the ask touches global state rather than one SKILL.md.

## Read first

- **Global config** — read it with the `configGet` tool (below).
- **Skills and agents** — the resolved skill search paths are in the `skill` tool's description; read them there rather than guessing, they depend on `TACO_HOME` and the workspace. The agent directories are listed in the Agents section below.
- **Desktop settings panes** — channel bindings and MCP servers live partly in the config file and partly in the desktop app's binding state. The file is what the sidecar loads; the UI may hold secrets it has not written back yet.

## Global config: use the config tools

Two deferred tools, listed in the system prompt's `<deferred_tools>` section:

```
addTools({ toolNames: "configGet,configPatch" })
```

Load them before use — they are not resident, so they are absent from the tool list until then. Both work only in a local desktop session: an IM conversation is driven by a third party, and a subagent runs without the user watching.

`configGet` returns the masked config. A stored key comes back as `{ configured: true, mask: "sk-ant-…AbCd" }` — you can confirm it is set and see a few characters of it, never read it back. MCP servers and channels are dropped from the response entirely. Provider entries are visible; their keys live in `apiKeys` and are masked there. Never read the config file with the `read` tool: it holds API keys in plaintext, and reading it puts them in the conversation.

`configPatch` takes a `patch` naming only the fields to change; everything else keeps its value. The user sees a prompt naming the changed fields and must approve before anything is written.

Accepted fields — this is the whole list:

- `defaultModel` / `defaultProvider` — single strings.
- `systemPrompt` — free text.
- `thinkingLevel` — `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- `compaction` — `{ enabled?, threshold? }`; threshold is 0.1–0.95.
- `instructions` — `{ enabled?, files?: { claudeMd?, agentsMd?, designMd? }, inheritToSubagents? }`. A nested merge: naming one file leaves the others alone.
- `commandPermissions` — `{ mode?: "ask" | "auto", allow?: string[], deny?: string[] }`. Glob patterns; deny wins and asks. Unmatched commands ask in `ask` mode and pass in `auto`. Built-in high-risk commands, parse failures and unauthorized `cd` always ask.

`allow` / `deny` are **replaced wholesale**, not merged — send the complete list. An omitted array keeps its value; `[]` clears it.

**Secrets are not settable here.** API keys, provider definitions, MCP servers, channels and the outbound `userAgent` are entered by the user in the desktop settings pane — Providers & Models for providers and request identity, the channel and MCP panes for the rest. Those paths write the secret without echoing it back. A patch naming one of these fields is refused before the user is even asked, so do not offer it as an option.

The `userAgent` is the identity every provider request presents, so only the user changes it (Providers & Models → Request identity). If the ask is "make the provider stop seeing this product", point them there.

The `productName` field sets the assistant’s name in its prompts. Ask the user to edit `$TACO_HOME/taco.json` and restart the sidecar. There is no desktop setting for this field, and `configPatch` cannot change it.

## Skills: where to put one

Skills resolve first-match-by-name across the search paths, so a project-local skill shadows a global one of the same name. Default to the global directory (`$TACO_HOME/skills/`, typically `~/.taco/skills/`) when the user has not said otherwise; use `askUser` with `scope` as the header when the choice matters — Global first, Project-local second. Never write to the builtin directory: it ships with the runtime and upgrades overwrite it.

Saving is enough — the directory is watched and the catalog reloads a moment later. If the running session's `<available_skills>` does not pick the skill up, start a new session.

`write` reaches the workspace and its associated directories, plus `$TACO_HOME/skills` and `$TACO_HOME/agents` for a local main session. Anywhere else needs a user-approved `shell`; `$TACO_HOME` itself is never writable, because it holds the config file.

For body composition, frontmatter keys, scripts-vs-body tradeoffs, and `runAs` / `inlineOnly` choices, defer to the `create-skill` skill.

## Agents: where to put one

Agents are `*.md` files, one agent per file, in one of four user directories: `~/.claude/agents/`, `~/.pi/agents/`, `$TACO_HOME/agents/` (default `~/.taco/agents/`), and `<workspace>/.taco/agents/`. Agent resolution is last-wins, the opposite of skills: a project-local agent overrides a global one of the same name for that workspace. Name the file after the `name` frontmatter so it is greppable.

Default to the global directory (`$TACO_HOME/agents/`) for personal agents; use the project-local one only when the agent is bound to this repo's conventions. In an IM conversation there is no project directory, so write global only. Before writing a global agent, check whether a project-local one of the same name exists — it would shadow the new copy in that workspace.

Frontmatter the runtime reads: `name` (the only required key), `description`, `whenToUse`, `tools` (a whitelist of tool names), `maxTurns`, `timeoutMinutes`, `context` (`independent`, or `fork` to hand the subagent this conversation's transcript), `runtime` (`standard`, `claude-code`, `codex`), `permissionMode`, `cwd`, `fewShots` (a YAML list of `{ user, assistant }` pairs injected ahead of the body), and a `codex` block of codex-runtime options.

`whenToUse` is a one-line hint shown in the system prompt's `<available_agents>` listing — prefer it over `description`, which is only metadata.

A `runtime: claude-code` agent takes `cwd`: the absolute directory it always runs in, fixed when the definition is written. Pick the workspace directory or one of its associated directories, and ask the user which one when it is not obvious. Omitted = the calling workspace's directory. The path applies from every workspace that calls the agent, so a global agent with a `cwd` sends every caller — IM conversations included — into that directory; say so before writing one.

## Installing a skill from a URL

Three shapes: a public GitHub repo with a top-level `SKILL.md` (`git clone --depth 1`, then move `SKILL.md` into `<target>/<repoName>/`), a path inside a repo (fetch the tarball with `curl -L | tar -xz -C <staging>`, copy the named directory), or a bare tarball or git URL (same flow, treat the unpacked root as the candidate).

Stage into `mktemp -d` to keep the workspace clean, then copy just the skill directory into the target. Validate `name` + `description` in the frontmatter before writing. If a higher-priority path already holds a skill with the same `name`, say so — first-match-by-name means the new copy will be shadowed.

Ask for the target with the same `scope` question used for local creation.

## The loop

1. Read what is there — the config via `configGet`, the candidate skill/agent directories, any same-named entry that would be shadowed.
2. Confirm scope and target with `askUser` when ambiguous — no narration.
3. Make the change. Skills/agents: write the file. Config: `configPatch`. Remote install: stage, validate, copy.
4. Verify. The sidecar picks a config change up as soon as it is written, but a new default model applies to new sessions — not to the chat that asked for it. A new skill lands in `<available_skills>` after the reload; start a new session if the running one does not list it.
5. If something does not load, read the sidecar log or ask what the SkillsPane diagnostics show. A missing or empty `description` is the one failure that drops a skill outright, and the pane names it.
