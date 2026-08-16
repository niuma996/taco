import { build } from "esbuild";

await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "lib/sidecar.mjs",
    minify: true,
    // `keepNames: true` preserves runtime class names that pi-ai and the
    // OpenAI/Anthropic SDKs read via `this.constructor.name` to build their
    // default `User-Agent` (e.g. `OpenAI/JS <version>`, `Anthropic/JS
    // <version>`). Without this, esbuild minifies `class OpenAI` into a
    // short identifier (e.g. `Nr`), making the default UA leak as
    // `Nr/JS <version>` — meaningless to anyone inspecting provider
    // access logs. We override that header with `taco/<version>` at every
    // taco-originated call site (see `tacoRequestHeaders`), so this flag
    // only affects the fallback path (e.g. an OAuth request where we
    // intentionally skip the override to preserve the provider identity).
    keepNames: true,
    // Optional deps stay out of the bundle; loaded at runtime via dynamic import (see channelFactory).
    external: ["@wechatbot/wechatbot"],
});
