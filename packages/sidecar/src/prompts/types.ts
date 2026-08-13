/**
 * `NamedTool` — minimal structural shape required by the prompt builder.
 *
 * Lives in its own module so `toolSummary.ts` can depend on it without
 * creating a `buildSystemPrompt ↔ toolSummary` cycle: both modules import
 * the type from here, neither imports the other through the type.
 *
 * The `taco` field is declared inline (instead of importing `TacoToolMetadata`
 * from `../tools/index.ts`) for the same reason — keeping the `prompts/`
 * module dependency graph a tree. The shape is identical; the source of
 * truth for the metadata definition still lives next to the tool factories.
 */

export interface NamedTool {
    readonly name: string;
    readonly taco?: {
        readonly promptSummary?: string;
        readonly mutates?: boolean;
    };
}
