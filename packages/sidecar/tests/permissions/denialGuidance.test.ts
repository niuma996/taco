/**
 * The shared denial guidance.
 *
 * Two properties matter and are easy to lose in a rewrite:
 *   - every reason says "do not retry" — a model that retries a denial
 *     wastes the user's attention and, worse, keeps the request alive.
 *   - every reason names the routes to the same outcome, so a model that
 *     reads "do not retry" as "use another tool" is told that the other
 *     tool is denied too.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { denialGuidance } from "../../src/permissions/denialGuidance.ts";

const subject = {
    action: "this command",
    alternativeRoutes: "a different command, a pipeline, or another tool",
};

describe("denialGuidance", () => {
    it("a user denial says do not retry and names the other routes", () => {
        const text = denialGuidance("user_denied", subject);
        assert.match(text, /user denied this command/);
        assert.match(text, /Do not retry it/);
        assert.match(text, /a different command, a pipeline, or another tool/);
        // The denial is about the intent, not the exact form.
        assert.match(text, /about the intent, not the exact form/);
    });

    it("a timeout still allows asking the user", () => {
        const text = denialGuidance("timeout", subject);
        assert.match(text, /timed out/);
        assert.match(text, /Do not retry automatically/);
        assert.match(text, /askUser/);
    });

    it("an abort says the turn was cancelled, not that the action was refused", () => {
        const text = denialGuidance("aborted", subject);
        assert.match(text, /cancelled/);
        assert.doesNotMatch(text, /The user denied/);
    });

    it("a missing approver points at the desktop app", () => {
        const text = denialGuidance("no_approver", subject);
        assert.match(text, /no desktop app is connected/);
        assert.match(text, /Do not retry it or work around it/);
    });

    it("a policy block is not a user refusal, so it does not route to askUser", () => {
        const text = denialGuidance(undefined, subject);
        assert.match(text, /blocked by the workspace's permission policy, not by the user/);
        assert.match(text, /a different command, a pipeline, or another tool/);
        // Nobody was asked, so there is no user in front of the model.
        assert.doesNotMatch(text, /askUser/);
    });

    it("every reason forbids a retry", () => {
        for (const reason of [
            "user_denied",
            "timeout",
            "aborted",
            "no_approver",
            undefined,
        ] as const) {
            assert.match(
                denialGuidance(reason, subject),
                /Do not retry/i,
                `reason ${String(reason)} must forbid a retry`,
            );
        }
    });
});
