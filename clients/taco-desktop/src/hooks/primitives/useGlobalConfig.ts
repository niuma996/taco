/**
 * Subscribes to the desktop GlobalConfig cache.
 * Seeds state synchronously because subscriptions do not emit on registration;
 * `loaded` tells callers whether initial loading has completed.
 */

import { useEffect, useState } from "react";

import {
    type GlobalConfigState,
    getGlobalConfig,
    subscribeGlobalConfig,
} from "../../lib/globalConfig.ts";

export function useGlobalConfig(): GlobalConfigState {
    const [state, setState] = useState<GlobalConfigState>(() => getGlobalConfig());
    useEffect(() => subscribeGlobalConfig(setState), []);
    return state;
}
