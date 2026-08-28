---
name: create-skill
description: Use when creating a new skill, adding scripts or reference files to one, editing an existing skill's behavior, or troubleshooting why a skill isn't loading or triggering.
---

# Creating a skill

A skill is a `SKILL.md` plus optional supporting files. The runtime watches the skills directories, so saving is enough — no install step, no restart.

## Start here: what the model sees, and when

The `description` is always in context; the body is loaded only after invocation. So the description is a **trigger**, not a summary. A description that describes the procedure trains the model to act from the description and never read the body.

```yaml
# Bad — summarizes the workflow
description: Reads the changelog, groups commits by type, writes release notes.

# Good — names the situations that should fire it
description: Use when drafting release notes, summarizing what shipped, or turning a commit range into a changelog entry.
```

## Where it goes

Read the resolved paths off the `skill` tool's description rather than guessing — they depend on `TACO_HOME` and the workspace. The default is the user-wide `$TACO_HOME/skills/` (typically `~/.taco/skills/`), so the skill is available across every workspace. Drop the file under `<workspace>/.taco/skills/` only when the user explicitly asks for a project-local skill.

The directory name must equal `name` in the frontmatter, or the skill is dropped.

## Layout for a skill with scripts

```
release-notes/
├── SKILL.md
├── references/
│   └── format.md          # loaded on demand, keeps SKILL.md small
└── scripts/
    └── collect.py         # deterministic work, not model work
```

The loader reads exactly one `SKILL.md` per directory and stops descending once it finds one, so `scripts/` and `references/` are never mistaken for skills. Name them anything; only `SKILL.md` is special.

**Reference supporting files by relative path** (`scripts/collect.py`). The runtime tells the model the skill's own location, so relative paths resolve without you hardcoding an absolute path that breaks on another machine.

### What belongs in a script vs. in the body

Put it in a script when the work is deterministic and the model would only be transcribing: parsing a file format, computing a diff, validating a schema, calling an API with fixed logic. Scripts do not consume context and cannot drift.

Keep it in the body when the work requires judgment: deciding what matters, phrasing something, choosing between approaches.

A skill that says "read every file in src/ and summarize" burns context. A skill that says "run `scripts/collect.py` and interpret the output" does not.

### Making scripts actually runnable

Say which interpreter and where to run from, because the model has to construct a real command:

```markdown
Run from the skill directory:
`python3 scripts/collect.py --since HEAD~20`

Outputs JSON on stdout: `{"commits": [...], "range": "..."}`.
```

Document the output shape. Otherwise the model guesses at parsing and misreads failures.

Scripts execute through the `shell` tool. If a skill declares `allowedTools`, that list is a **filter** — omit `shell` and the scripts silently become unrunnable. Simplest correct choice: don't set `allowedTools` at all, and the skill inherits the normal toolset.

## Two execution modes, one asymmetry that matters

By default a skill runs **inline**: its body is injected into the current session, so it sees your conversation and can use the full toolset.

With `runAs: subagent`, the body becomes a fresh session's prompt. Cleaner for big mechanical jobs, but the subagent starts with no conversation context and cannot invoke skills itself. Reach for it when the skill is self-contained and verbose; stay inline otherwise.

If a skill only makes sense inline — because it needs to see the conversation, or dispatches subagents of its own — mark it `inlineOnly: true` so a subagent invocation fails loudly instead of running a broken shape.

## The loop

1. Write the description first. That is what determines whether the skill ever fires.
2. Write the body. Push deterministic work into `scripts/`, long reference material into `references/`.
3. Save. Reload is automatic (~300ms) — no restart.
4. Check `skills.list`. If the skill is missing or misbehaving, its `diagnostics` say why: YAML that didn't parse, a name that doesn't match its directory, a same-name skill shadowing yours, or a bad frontmatter value. Read the diagnostic before re-reading your file.
5. Invoke it with the `skill` tool. Run any scripts end to end — a script that fails on a real path is the most common defect, and it never shows up until you run it.
6. Watch a couple of real uses and tighten what the model got wrong. Reload is fast enough to iterate in one sitting.

## When it doesn't fire

The skill loaded (it's in `skills.list` with no diagnostics) but the model never reaches for it. That's a description problem, not a body problem: it doesn't name the situation the user is actually in. Rewrite it around the user's symptoms and vocabulary, not your internal name for the task.
