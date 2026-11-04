/**
 * Model lookup helpers that depend only on pi's catalog types.
 *
 * Split out of `modelRegistry.ts` so that callers which only need to resolve
 * a model by id do not pull in the registry — and through it the session
 * layer, which the registry consults to read a session's attached model.
 * Importing that path from a low-level module closes a dependency cycle.
 */

import type { MutableModels } from "@earendil-works/pi-ai";
import type { Api, Model } from "../pi/types.ts";

/** Looks up a model by id across providers. */
export function findModelById(models: MutableModels, id: string): Model<Api> | undefined {
    for (const m of models.getModels() as Array<Model<Api>>) {
        if (m.id === id) return m;
    }
    return undefined;
}
