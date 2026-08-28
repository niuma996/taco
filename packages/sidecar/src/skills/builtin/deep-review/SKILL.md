---
name: deep-review
description: Use when reviewing a change too large or too interconnected for one pass — many files, several modules, or high blast radius. Dispatches 2-5 `reviewer` subagents in a single turn, each carrying a different lens (concern, module, or role), then cross-checks their findings against each other and the actual files and synthesizes one ranked review. Optionally pairs with `verification` to empirically settle testable claims. Inline only.
runAs: inline
inlineOnly: true
---

# Deep Review

## Overview

One reviewer reading a 40-file change reads it once, in one order, with one set of priors. It will find what that order surfaces and miss what it doesn't. This skill splits the same body of work across 2-5 `reviewer` subagents, each given a **different lens**, dispatched in one turn so they run concurrently.

**Core principle:** the reviewers deliberately overlap. This is the opposite of `fan-out-agents`, where the domains must be independent and non-overlapping. Here, several reviewers reading the same file through different lenses is the entire point — an architecture lens and a correctness lens looking at the same function are asking different questions and will find different defects.

Corroboration is a by-product: when two independent lenses flag the same line, confidence rises sharply.

## When to Use

**Use when:**
- The change spans many files, or several modules with real coupling between them
- Blast radius is wide — touching permissions, auth, data handling, migrations, shared primitives
- The work is done and you want a genuine adversarial pass before declaring it complete
- A single review pass already happened and felt thin relative to the risk

**Don't use when:**
- The change is small or self-contained — review it inline; five subagents on a 20-line diff is pure overhead
- Nothing is written yet — this reviews work, it does not design it
- You want tests run, builds checked, or endpoints exercised — that is `verification`, not `reviewer`. Reviewers are read-only and reason about code; they do not prove runtime behavior
- You have not yet determined what changed — scope it first (see Step 1)

## The Pattern

### 1. Scope the change yourself, first

Establish the file list in your **own** session before dispatching anything:

```text
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Do **not** delegate this. If each reviewer runs its own `git diff`, they each burn turns rediscovering the same list, and worse, they may disagree about the boundary and review different things while reporting as if they reviewed the same change.

Hand every reviewer an explicit file list. A reviewer that has to guess its own scope will guess differently from its siblings.

### 2. Choose the split axis

Pick **one** axis. Mixing axes produces reviewers whose coverage overlaps in unpredictable ways and leaves gaps neither of you notices.

**By concern** — the default. Best when the change is cohesive but risky:

| Lens | Asks |
|---|---|
| Architecture | Do the seams belong where they are? Is a boundary being violated? Is this the right layer? |
| Implementation | Is this code correct? Off-by-one, inverted conditions, null handling, races |
| Ripple effects | What else calls this? What contracts changed? Who breaks downstream? |
| User experience | What does a user actually see when this fails, is slow, or is misused? |

**By module** — best when the change spans subsystems with distinct conventions. One reviewer per module, each given only its own file subset plus the interface it shares with the others. Say explicitly where each module's boundary is so cross-module contract breaks land with exactly one reviewer, not zero.

**By role** — best when the change crosses a stack boundary. An architect, a frontend developer, a backend developer read the same diff with genuinely different instincts about what is dangerous.

These three are examples, not a fixed menu. Invent the axis that matches where the risk actually concentrates in *this* change — a migration might split into "data safety / rollback path / query performance"; a permissions change into "escalation / bypass / audit trail".

### 3. Choose the context mode per lens

`reviewer` defaults to `context: fork`, so it sees a transcript of this conversation and can weigh the result against the intent that was discussed. That is right for some lenses and wrong for others. Set `context` explicitly per call:

| Lens type | Mode | Why |
|---|---|---|
| Intent alignment, architecture, UX-against-stated-requirements | `fork` | Needs to know what was asked for and which tradeoffs were accepted; judging seams without knowing the intent produces style opinions |
| Correctness, security, ripple effects | `independent` | A clean-room read. Should discover call sites rather than be told about them, and must not inherit the author's rationalizations for why an edge case is fine |

Deliberately mixing both gives you an intent-aware reading *and* an unanchored one. That contrast is often where the real findings are: something the conversation treated as settled that a clean-room reader immediately questions.

Note that `fork` costs more — each forked reviewer carries a transcript snapshot. Prefer `independent` when the lens does not genuinely need the conversation.

### 4. Compose the prompts

Every reviewer needs four things. The lens is the only variable; keep the rest parallel across calls so their reports are comparable.

1. **Its lens, stated as the question it should be asking** — not just a label
2. **The explicit file list** it owns (and, for module splits, the boundary)
3. **A cap on output** — "at most 6 findings, most severe first". Five uncapped reports will flood your context and bury the real findings
4. **The report shape** — severity, `file:line`, one-sentence defect, concrete failure scenario

State what is out of scope too. A reviewer told only "review the auth change" will also tell you about naming and formatting.

### 5. Dispatch in one turn

Issue every `agent` call in the same assistant message. The `agent` tool is `executionMode: parallel`, so the harness runs the batch concurrently:

```text
agent(subagent_type=reviewer, context=fork,        description="architecture lens", prompt="...")
agent(subagent_type=reviewer, context=independent, description="correctness lens",  prompt="...")
agent(subagent_type=reviewer, context=independent, description="ripple lens",       prompt="...")
agent(subagent_type=reviewer, context=fork,        description="UX lens",           prompt="...")
```

> **Keep the batch pure.** If any call in the turn is a sequential tool (most write tools, `askUser`, `planEnter`/`planExit`), the harness degrades the **whole batch** to sequential and you lose the concurrency. Do sequential prerequisites — including the Step 1 `git diff` — in an earlier turn.

> **Reviewers cannot fan out further.** The `agent` tool is removed at depth ≥ 1, so a reviewer cannot spawn sub-reviewers. All dispatch happens from here.

**Why 2-5.** Below 2 there is no second perspective and you should review inline. Above 5, lenses start restating each other, and the dedup and integration burden grows faster than the coverage does. Scale to blast radius, not to file count: a 60-file mechanical rename needs 2 lenses; a 12-file permissions change may deserve 5.

### 6. Deduplicate, corroborate, rank

The reports arrive as independent opinions of varying quality. Your job is synthesis, not concatenation.

1. **Merge by `file:line`.** The same defect will arrive from several lenses in different words.
2. **Treat corroboration as confidence, not as a vote.** Two lenses independently reaching the same line is strong signal. But do **not** discard single-lens findings — a privilege-escalation bug is *supposed* to be visible only to the lens looking for it. Unanimity is not the bar; being right is. Judge a lone finding on its stated failure scenario.
3. **Verify anything you intend to act on.** Reviewers reason about code without running it, so they produce confident-sounding findings that do not reproduce. Open the file and confirm the defect exists before you fix or report it.
4. **Discard what does not survive.** A finding you could not confirm is not a finding; say you could not confirm it rather than passing it along hedged.
5. **Rank by severity across all lenses,** not per-lens — the user wants one ordered list.
6. **Account for coverage.** If a lens returned nothing, or hit its turn cap, or came back obviously thin, say so. A silent gap reads as "this area is clean" when it actually means "nobody looked".

### 7. Optionally pair with `verification`

Reviewers claim; `verification` proves. Where a HIGH finding asserts something testable — "this crashes on empty input", "this races under concurrent calls" — dispatch `verification` in a **following** turn to actually run it:

```text
agent(subagent_type=verification, description="probe empty-input crash", prompt="...reproduce, report PASS/FAIL...")
```

This has to be a later turn because the prompt depends on what the review pass returned. `verification` holds a writable shell (it needs one to run builds and write scratch scripts to `/tmp`), unlike `reviewer` — which is why it can empirically settle a claim the reviewers could only argue about.

Skip this when the findings are structural (a misplaced boundary, a leaked abstraction) — there is nothing to execute.

When a `verification` verdict contradicts a reviewer, **the verdict wins**: it ran the code, the reviewer only read it. Drop the finding and say it did not reproduce. Do not keep it hedged as "possible issue" — a claim that was tested and failed to reproduce is resolved, not uncertain.

### 8. Deliver one synthesized review

Your final message is the review. It replaces the subagent reports — the user does not see them, so anything you do not carry forward is lost.

Report, in this order:

1. **One-line verdict** — the headline: is this safe to land, and if not, what is the single worst problem.
2. **Confirmed findings, ranked by severity across all lenses.** For each: severity · `file:line` · the defect in one sentence · the concrete failure scenario. Note which lenses raised it only when corroboration is what makes it credible.
3. **What was checked and found clean** — one line per lens. This is what makes the review auditable rather than a list of complaints.
4. **Coverage gaps** — lenses that returned thin, capped out, or were not run; claims you could not confirm either way; anything a follow-up pass should pick up.

Attribute a finding to a lens only when it carries information ("both the architecture and ripple lenses independently flagged this boundary"). Otherwise drop the attribution — which subagent found it is your bookkeeping, not the user's.

Keep the whole thing proportional to what was actually found. Five reviewers returning nothing serious should produce a short answer that says so plainly, not a long one padded to look like the effort was worth it.

## Prompt Template

```markdown
Review this change through the RIPPLE EFFECTS lens only.

Files changed (authoritative — do not re-derive):
  packages/sidecar/src/runtime/agentSpawner.ts
  packages/sidecar/src/agents/types.ts
  packages/sidecar/src/tools/agent.ts

Your lens — ask only these questions:
  - Who calls the functions whose signatures changed, and do all call sites still hold?
  - Which persisted shapes (session metadata, wire types) changed, and can old data still be read?
  - What did this change make dead, and what now has two sources of truth?

Explicitly out of scope: naming, formatting, test coverage, architectural taste.
Other reviewers are covering architecture and correctness — do not duplicate them.

Return at most 6 findings, most severe first. For each:
  severity (HIGH/MEDIUM/LOW) · file:line · one-sentence defect · concrete failure scenario
If a question above is clean, say so in one line. Do not pad the list.
```

## Common Mistakes

**❌ Same prompt, different `subagent_type`** — the lens must live in the prompt. Sending four identical prompts gets four near-identical reports.

**❌ Letting each reviewer scope itself** — they diverge on the boundary and you cannot tell which parts got reviewed.

**❌ Uncapped output** — five reviewers each returning twenty findings buries the three that mattered.

**❌ Concatenating reports as your answer** — the user asked for a review, not five reviews. Dedupe, verify, rank.

**❌ Reporting per-lens sections** — "Architecture lens found… Correctness lens found…" pushes your dedup work onto the reader and hides that two lenses flagged the same line. Rank by severity across all lenses instead.

**❌ Staying silent about a lens that returned nothing** — indistinguishable from that area being clean. Say which lenses came back empty.

**❌ Trusting a finding you never opened the file to confirm** — reviewers reason without running anything and are confidently wrong at a steady rate.

**❌ Mixing axes** — "architecture, correctness, and also the auth module" leaves coverage gaps nobody notices.

**❌ Using this on a small diff** — the coordination cost exceeds the benefit. Review it yourself.

**❌ Expecting reviewers to run tests** — `reviewer` is read-only by construction (its shell is swapped for a read-only broker). Use `verification` for anything that must actually execute.

## Mode Constraint

This skill is **inline-only**. Its body must land in your current context so it can shape the tool calls of the same turn. It must not run as a subagent: a subagent cannot see your session state, and the `agent` tool is stripped at depth ≥ 1, so it could not dispatch the fan-out at all. If you find this skill executing inside a subagent, that is a misconfiguration — load it in the main session instead.
