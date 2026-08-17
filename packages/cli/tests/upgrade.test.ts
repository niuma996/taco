/**
 * `taco upgrade` integration tests with a fake fetcher + fake registry
 * pointing at a tmpdir-backed tarball. We build the tarball in-test using
 * the `tar` package (the same one production uses for extraction) so
 * the round-trip exercises the real code paths — no manual mocking of
 * fs internals, no precomputed fixtures.
 */

import { ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, pipeline } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { create as tarCreate } from "tar";
import { upgradeCommand } from "../lib/upgrade.ts";
import { readUpgradeMarker } from "../lib/upgradeMarker.ts";

const pipelineAsync = promisify(pipeline);

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-cli-upgrade-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** Build a tarball-shaped byte stream (npm-style: `package/` top-level
 *  wrapping manifest.json + bin/ + lib/). The content + tarball bytes
 *  are returned so the caller can wire up the fake fetcher + integrity. */
async function buildTarball(): Promise<{ tarball: Buffer; integrity: string }> {
    const staging = await mkdtemp(join(tmpdir(), "taco-cli-tar-src-"));
    try {
        await mkdir(join(staging, "package", "bin"), { recursive: true });
        await mkdir(join(staging, "package", "lib"), { recursive: true });
        await writeFile(
            join(staging, "package", "manifest.json"),
            JSON.stringify({ target: "aarch64-apple-darwin" }),
            "utf8",
        );
        await writeFile(
            join(staging, "package", "bin", "taco-sidecar-node"),
            "#!/bin/sh\necho stub\n",
            "utf8",
        );
        await writeFile(
            join(staging, "package", "lib", "index.mjs"),
            "export const version = '0.2.0';\n",
            "utf8",
        );
        // Pack → gzip in-memory so the registry fetcher returns a real tar.gz.
        const chunks: Buffer[] = [];
        const sink = new PassThrough();
        sink.on("data", (c: Buffer) => chunks.push(c));
        const packStream = tarCreate({ cwd: staging, gzip: false, portable: true }, ["package"]);
        await pipelineAsync(packStream, createGzip(), sink);
        const tarball = Buffer.concat(chunks);
        const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
        return { tarball, integrity };
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

interface FakeResponse {
    status: number;
    body: Buffer;
    contentType?: string;
}

function makeFakeFetcher(responses: Map<string, FakeResponse>): typeof fetch {
    return (async (url: string | URL | Request): Promise<Response> => {
        const key = String(url);
        const entry = responses.get(key);
        if (!entry) {
            return new Response(JSON.stringify({ error: "not in fake" }), {
                status: 404,
                headers: { "content-type": "application/json" },
            });
        }
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(entry.body));
                controller.close();
            },
        });
        return new Response(stream, {
            status: entry.status,
            headers: {
                "content-type": entry.contentType ?? "application/octet-stream",
            },
        });
    }) as unknown as typeof fetch;
}

test("upgradeCommand fetches metadata, downloads, verifies, extracts, writes marker", async () => {
    await withTmp(async (home) => {
        const liveDir = join(home, "live");
        await mkdir(liveDir, { recursive: true });
        const { tarball, integrity } = await buildTarball();
        const meta = {
            name: "@taco-ai/sidecar-darwin-arm64",
            version: "0.2.0",
            dist: {
                tarball: "https://registry.example/sidecar-darwin-arm64-0.2.0.tgz",
                integrity,
            },
        };
        const fetcher = makeFakeFetcher(
            new Map([
                [
                    "https://registry.example/@taco-ai/sidecar-darwin-arm64/latest",
                    {
                        status: 200,
                        body: Buffer.from(JSON.stringify(meta)),
                        contentType: "application/json",
                    },
                ],
                [meta.dist.tarball, { status: 200, body: tarball }],
            ]),
        );

        const result = await upgradeCommand({
            fetcher,
            tacoHome: home,
            registry: "https://registry.example",
            platformKey: "darwin-arm64",
            liveDirOverride: liveDir,
        });

        strictEqual(result.version, "0.2.0");
        strictEqual(result.liveDir, liveDir);

        const marker = await readUpgradeMarker(join(home, "upgrade-marker.json"));
        ok(marker);
        strictEqual(marker?.version, "0.2.0");
        strictEqual(marker?.live_dir, liveDir);

        // Extracted bundle shape: manifest.json is parseable, target matches.
        const stagingManifest = await readFile(join(result.stagingDir, "manifest.json"), "utf8");
        const stagingPkg = JSON.parse(stagingManifest) as { target?: string };
        strictEqual(stagingPkg.target, "aarch64-apple-darwin");
    });
});

test("upgradeCommand throws on integrity mismatch", async () => {
    await withTmp(async (home) => {
        const liveDir = join(home, "live");
        await mkdir(liveDir, { recursive: true });
        const { tarball } = await buildTarball();
        const meta = {
            name: "@taco-ai/sidecar-darwin-arm64",
            version: "0.2.0",
            dist: {
                tarball: "https://registry.example/sidecar-darwin-arm64-0.2.0.tgz",
                integrity: "sha512-" + "A".repeat(86),
            },
        };
        const fetcher = makeFakeFetcher(
            new Map([
                [
                    "https://registry.example/@taco-ai/sidecar-darwin-arm64/latest",
                    {
                        status: 200,
                        body: Buffer.from(JSON.stringify(meta)),
                        contentType: "application/json",
                    },
                ],
                [meta.dist.tarball, { status: 200, body: tarball }],
            ]),
        );

        await rejects(
            upgradeCommand({
                fetcher,
                tacoHome: home,
                registry: "https://registry.example",
                platformKey: "darwin-arm64",
                liveDirOverride: liveDir,
            }),
            /integrity mismatch/,
        );
    });
});

test("upgradeCommand propagates registry 404", async () => {
    await withTmp(async (home) => {
        const fetcher = makeFakeFetcher(new Map());
        await rejects(
            upgradeCommand({
                fetcher,
                tacoHome: home,
                registry: "https://registry.example",
                platformKey: "darwin-arm64",
                liveDirOverride: join(home, "live"),
            }),
            /registry returned 404/,
        );
    });
});

test("upgradeCommand throws when staged bundle is missing required files", async () => {
    await withTmp(async (home) => {
        const liveDir = join(home, "live");
        await mkdir(liveDir, { recursive: true });
        // Build an intentionally-bad tarball (no manifest.json).
        const staging = await mkdtemp(join(tmpdir(), "taco-cli-tar-bad-"));
        try {
            await mkdir(join(staging, "package"), { recursive: true });
            await writeFile(join(staging, "package", "package.json"), "{}", "utf8");
            const chunks: Buffer[] = [];
            const sink = new PassThrough();
            sink.on("data", (c: Buffer) => chunks.push(c));
            await pipelineAsync(
                tarCreate({ cwd: staging, gzip: false, portable: true }, ["package"]),
                createGzip(),
                sink,
            );
            const tarball = Buffer.concat(chunks);
            const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
            const meta = {
                name: "@taco-ai/sidecar-darwin-arm64",
                version: "0.2.0",
                dist: { tarball: "https://registry.example/bad.tgz", integrity },
            };
            const fetcher = makeFakeFetcher(
                new Map([
                    [
                        "https://registry.example/@taco-ai/sidecar-darwin-arm64/latest",
                        {
                            status: 200,
                            body: Buffer.from(JSON.stringify(meta)),
                            contentType: "application/json",
                        },
                    ],
                    [meta.dist.tarball, { status: 200, body: tarball }],
                ]),
            );

            await rejects(
                upgradeCommand({
                    fetcher,
                    tacoHome: home,
                    registry: "https://registry.example",
                    platformKey: "darwin-arm64",
                    liveDirOverride: liveDir,
                }),
                /staged bundle missing manifest.json/,
            );
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
    });
});
