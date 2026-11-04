import { strict as assert } from "node:assert";
import { it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { contextFor } from "../../src/lib/harnessContext.ts";
import {
    AgentHarness,
    BACKGROUND_CONTEXT,
    InMemoryTelemetryContext,
    MemorySessionRepo,
    withTelemetryContext,
} from "../../src/runtime/pi/values.ts";

it("records model spans and metrics through the installed harness with a cancellable taco context", async () => {
    const recorder = new InMemoryTelemetryContext();
    const controller = new AbortController();
    const context = withTelemetryContext(recorder, contextFor(controller.signal));
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("hello")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, context);
    const { harness } = await AgentHarness.create(
        { session, models, model: faux.getModel() },
        context,
    );
    try {
        const lane = await harness.lane("main", context);
        const result = await lane.prompt("hello", undefined, context);
        assert.equal(result.ok && result.value.status, "completed");
        assert.ok(recorder.getSpans().some((span) => span.name === "pi.ai.request"));
        assert.ok(recorder.getSpans().every((span) => span.settled));
        assert.ok(recorder.getMetrics().some((metric) => metric.name === "pi.ai.request.duration"));
        assert.equal(context.abortSignal, controller.signal);
    } finally {
        await harness.close(BACKGROUND_CONTEXT);
        await session.close(BACKGROUND_CONTEXT);
    }
});
