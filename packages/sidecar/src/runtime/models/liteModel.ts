/**
 * Optional lightweight model for bounded auxiliary calls.
 *
 * Only session titles and memory extraction use this. Callers truncate the
 * conversation; the full request, including existing memories, is checked
 * against the lite window before sending. Compaction and memory.dream keep
 * the main model because their input grows with its window.
 *
 * Two failure modes are both non-fatal by design: an unset/unresolvable
 * `liteModel` means "use the main model", and a failed lite call retries once
 * on the main model. Auxiliary work is fire-and-forget, so neither may ever
 * surface as a run failure.
 */

import { readGlobalConfig } from "../../config/config.ts";
import { createLogger } from "../../lib/logger.ts";
import type {
    Api,
    ApiContext,
    AssistantMessage,
    Model,
    Models,
    MutableModels,
} from "../pi/types.ts";
import { estimateApiContextTokens, normalizeContext } from "../pi/values.ts";
import { findModelById } from "./modelLookup.ts";

const log = createLogger("sidecar.liteModel");

/** Rough token estimate used by the callers' own truncation heuristic. */
const CHARS_PER_TOKEN = 4;
/** Leave room for the system prompt and the model's own reasoning. */
const PROMPT_OVERHEAD_CHARS = 2000;
// pi's simple-stream adapters subtract this margin before allocating output.
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_OUTPUT_TOKENS = 1024;

/**
 * Character budget of the serialized conversation each auxiliary caller
 * feeds in. A lite model whose declared window cannot hold the budget (plus
 * prompt overhead) is skipped for that scenario — the main model keeps it.
 */
export type LiteScenario = "title" | "memory";

export const LITE_BUDGET_CHARS: Record<LiteScenario, number> = {
    title: 4000,
    memory: 8000,
};

/**
 * Resolve the configured lite model against the workspace's live catalog.
 * Called on every auxiliary request, not once at attach — a `settings.write`
 * change to `liteModel` or the provider catalog must reach an already-attached
 * session without a re-attach.
 *
 * `models` is the workspace's shared registry; a second model needs no new
 * process or registry. `undefined` means the caller should use its main model.
 */
export function resolveLiteModel(
    models: MutableModels,
    scenario: LiteScenario,
): Model<Api> | undefined {
    const configured = readGlobalConfig().liteModel;
    if (!configured) return undefined;

    const slash = configured.indexOf("/");
    const model =
        slash > 0
            ? models.getModel(configured.slice(0, slash), configured.slice(slash + 1))
            : findModelById(models, configured);
    if (!model) return undefined;

    // The registry fills a default window for custom models, so every model
    // has a usable value. An explicitly small window disqualifies this scenario.
    const neededChars = LITE_BUDGET_CHARS[scenario] + PROMPT_OVERHEAD_CHARS;
    if (model.contextWindow * CHARS_PER_TOKEN < neededChars) {
        return undefined;
    }
    return model;
}

type SimpleArgs = Parameters<Models["completeSimple"]>;
type SimpleOptions = NonNullable<SimpleArgs[2]>;

/**
 * Run one auxiliary completion on the lite model, falling back to the main
 * model when the lite call fails or produces no text. `getLite` is a thunk so
 * the config read happens at call time; `optionsFor` re-derives per-model
 * options (thinking level differs between a reasoning and a non-reasoning
 * model) for whichever model is actually being called.
 *
 * Returns `undefined` on total failure — the callers already treat a missing
 * response as "no title / no facts this run" and never propagate it.
 */
export async function completeSimpleWithLiteFallback(
    models: Models,
    getLite: () => Model<Api> | undefined,
    main: Model<Api>,
    context: ApiContext,
    optionsFor: (model: Model<Api>) => SimpleOptions,
): Promise<AssistantMessage | undefined> {
    const lite = getLite();
    if (!lite || !fitsLiteWindow(lite, context)) {
        log.info("auxiliary call on the session model", {
            model: `${main.provider}/${main.id}`,
            reason: lite ? "window too small" : "no lite model configured",
        });
        return await attempt(models, main, context, optionsFor(main));
    }

    const result = await attempt(models, lite, context, optionsFor(lite));
    if (result) {
        log.info("auxiliary call on the lite model", {
            model: `${lite.provider}/${lite.id}`,
        });
        return result;
    }

    log.warn("lite model call failed; retrying on the session model", {
        lite: `${lite.provider}/${lite.id}`,
    });
    return await attempt(models, main, context, optionsFor(main));
}

function fitsLiteWindow(model: Model<Api>, context: ApiContext): boolean {
    const inputTokens = estimateApiContextTokens(normalizeContext(context)).tokens;
    const outputTokens = Math.min(model.maxTokens, MIN_OUTPUT_TOKENS * (model.reasoning ? 2 : 1));
    return inputTokens + CONTEXT_SAFETY_TOKENS + outputTokens <= model.contextWindow;
}

/** Failed streams can retain partial text; never treat it as a completed answer. */
async function attempt(
    models: Models,
    model: Model<Api>,
    context: ApiContext,
    options: SimpleOptions,
): Promise<AssistantMessage | undefined> {
    try {
        const res = await models.completeSimple(model, context, options);
        if (res.stopReason === "error" || res.stopReason === "aborted") {
            log.warn("auxiliary completion failed:", {
                model: `${model.provider}/${model.id}`,
                stopReason: res.stopReason,
                error: res.errorMessage,
            });
            return undefined;
        }
        const hasText = res.content.some(
            (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
        );
        return hasText ? res : undefined;
    } catch (err) {
        log.warn("auxiliary completion failed:", {
            model: `${model.provider}/${model.id}`,
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}
