import { build } from "esbuild";

await build({
    entryPoints: ["lib/index.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "dist/taco.mjs",
    minify: true,
});
