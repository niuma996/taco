import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createPlanExitTool, type PlanExitToolDetails } from "../../src/tools/planExit.ts";
import { createPlanModeState, enterPlanMode } from "../../src/tools/planModeState.ts";

describe("planExit tool", () => {
    let testDir: string;
    let state: ReturnType<typeof createPlanModeState>;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-plans-test-"));
        state = createPlanModeState();
    });

    it("returns plan preview and terminates on first call", async () => {
        enterPlanMode(state, "test-plan");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "test-plan.md"), "# Plan\n\nDo stuff.\n\nMore details.");

        const tool = createPlanExitTool(state, testDir, undefined, "");
        const result = await tool.execute("tc-1", { planSlug: "test-plan" }, undefined, undefined, {
            env: new NodeExecutionEnv({ cwd: "/" }),
        });

        assert.equal(result.terminate, true);
        assert.equal(result.content[0].type, "text");
        if (result.content[0].type === "text") {
            assert.match(result.content[0].text, /Do stuff/);
        }
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.questions?.[0].question, "Approve this plan?");
        assert.equal(state.active, true);

        rmSync(testDir, { recursive: true, force: true });
    });

    it("rejects if not in plan mode", async () => {
        const tool = createPlanExitTool(state, testDir, undefined, "");
        try {
            await tool.execute("tc-1", { planSlug: "test-plan" }, undefined, undefined, {
                env: new NodeExecutionEnv({ cwd: "/" }),
            });
            assert.fail("Should have thrown");
        } catch (error) {
            assert.match((error as Error).message, /Not in plan mode/);
        }

        rmSync(testDir, { recursive: true, force: true });
    });

    it("exits plan mode when user approves", async () => {
        enterPlanMode(state, "test-plan");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "test-plan.md"), "# Plan\n\nDo stuff.");

        const tool = createPlanExitTool(state, testDir, undefined, "");
        const result = await tool.execute(
            "tc-2",
            { planSlug: "test-plan", answers: { "Approve this plan?": "Approve" } },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        assert.equal(state.active, false);
        assert.equal(state.currentSlug, null);
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, true);

        rmSync(testDir, { recursive: true, force: true });
    });

    it("keeps plan mode when user rejects", async () => {
        enterPlanMode(state, "test-plan");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "test-plan.md"), "# Plan\n\nDo stuff.");

        const tool = createPlanExitTool(state, testDir, undefined, "");
        const result = await tool.execute(
            "tc-2",
            { planSlug: "test-plan", answers: { "Approve this plan?": "Reject" } },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        assert.equal(state.active, true);
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, false);

        rmSync(testDir, { recursive: true, force: true });
    });
});

describe("planExit tool — schema robustness", () => {
    let testDir: string;
    let state: ReturnType<typeof createPlanModeState>;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-plans-schema-"));
        state = createPlanModeState();
    });

    it("omitting planSlug uses state.currentSlug to locate the plan file", async () => {
        enterPlanMode(state, "stored-slug");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "stored-slug.md"), "# Plan from state\n\nBody.");

        const tool = createPlanExitTool(state, testDir, undefined, "");
        // No planSlug passed — relies entirely on state.currentSlug
        const result = await tool.execute("tc", {}, undefined, undefined, {
            env: new NodeExecutionEnv({ cwd: "/" }),
        });

        assert.equal(result.terminate, true);
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.questions?.[0].question, "Approve this plan?");
        assert.match(details.planContent, /Plan from state/);
        rmSync(testDir, { recursive: true, force: true });
    });

    it("second call skips readFileSync — Approve works even after .md is deleted", async () => {
        enterPlanMode(state, "ephemeral");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        const mdPath = join(plansDir, "ephemeral.md");
        writeFileSync(mdPath, "# Ephemeral");

        const tool = createPlanExitTool(state, testDir, undefined, "");
        // Simulate user/system deleting the plan document while waiting
        rmSync(mdPath, { force: true });

        // Second call, with answers — must not throw "Plan document not found"
        const result = await tool.execute(
            "tc",
            { planSlug: "ephemeral", answers: { "Approve this plan?": "Approve" } },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        assert.equal(state.active, false, "Approve should still exit plan mode");
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, true);
        assert.equal(details.planContent, "", "second-call details should not carry plan content");
        rmSync(testDir, { recursive: true, force: true });
    });

    it("second call without planSlug also works via state.currentSlug", async () => {
        enterPlanMode(state, "no-slug-2nd");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "no-slug-2nd.md"), "# Body");

        const tool = createPlanExitTool(state, testDir, undefined, "");
        // Delete .md — but because this is a second call (with answers), it still doesn't read the file
        rmSync(join(plansDir, "no-slug-2nd.md"), { force: true });

        const result = await tool.execute(
            "tc",
            { answers: { "Approve this plan?": "Reject" } },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        assert.equal(state.active, true, "Reject should keep plan mode active");
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, false);
        rmSync(testDir, { recursive: true, force: true });
    });
});
