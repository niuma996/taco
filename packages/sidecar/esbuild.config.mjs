import { build } from "esbuild";

await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "lib/sidecar.mjs",
    minify: true,
    // Optional deps stay out of the bundle; loaded at runtime via dynamic import (see channelFactory).
    external: ["@wechatbot/wechatbot"],
});
