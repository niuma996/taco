/**
 * skill tool summary — which skill was loaded.
 *
 * The default summary would fall through to a JSON dump of `{ skill, args }`,
 * burying the name behind punctuation. `details.skillName` is the authoritative
 * source (the sidecar sets it on every branch, including not-found); `args.skill`
 * covers the window before the result lands, when the card is still running.
 *
 * `runAs: "subagent"` is worth surfacing: those skills execute in a child
 * session rather than injecting into this one, which is the difference between
 * "the model now knows this playbook" and "something else ran on its own".
 */

import type { UiToolCall } from "../../lib/chat/chatUtils";
import { truncate } from "./_util";
import { toolViews } from "./registry";

interface SkillToolDetailsShape {
    skillName?: unknown;
    found?: unknown;
    runAs?: unknown;
}

function summarizeSkill(tool: UiToolCall): string {
    const details = (tool.details ?? {}) as SkillToolDetailsShape;
    const args = (tool.args ?? {}) as { skill?: unknown };
    // details wins: a running card only has args, but once the result lands the
    // sidecar's own name is what actually resolved.
    const name =
        typeof details.skillName === "string" && details.skillName.length > 0
            ? details.skillName
            : typeof args.skill === "string"
              ? args.skill
              : "";
    if (name === "") return "";
    const head = truncate(name, 60);
    return details.runAs === "subagent" ? `${head} · subagent` : head;
}

// Summary only: the body is the tool's own activation message, which already
// reads as a sentence and needs no special rendering.
toolViews.skill = { summary: summarizeSkill };
