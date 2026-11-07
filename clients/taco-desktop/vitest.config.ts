import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "happy-dom",
        // Component tests mount real markdown/shiki pipelines and Radix portals.
        // Capping workers keeps shiki grammar loading from starving the timers
        // these tests rely on (default CPU-count parallelism made the same
        // assertions pass or fail depending on machine load).
        maxWorkers: 4,
        // A loaded box needs more than the 5s default before a legitimate
        // render is called a hang.
        testTimeout: 15000,
        // Only runs .test.tsx — other .test.ts go through the `pnpm test`
        // tsx --test path. Pure function + reducer unit tests use node:test;
        // React component tests use vitest. A glob (rather than an explicit
        // file list) keeps a newly added component test from being silently
        // skipped.
        include: ["tests/**/*.test.tsx"],
    },
});
