import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { useFilePreview } from "../../src/hooks/useFilePreview";
import type { FsClient } from "../../src/lib/clients/fsClient";
import { MAX_PREVIEW_BYTES } from "../../src/lib/fileTypes";

function makeApi(opts: { text?: string; size?: number; throws?: boolean } = {}): FsClient {
    return {
        readDir: vi.fn(async () => {
            return [];
        }),
        readText: vi.fn(async () => {
            if (opts.throws) throw new Error("EACCES");
            return opts.text ?? "";
        }),
        sizeOf: vi.fn(async () => opts.size ?? 10),
    };
}

describe("useFilePreview — binary short-circuit", () => {
    it("blocks binary extensions without reading", async () => {
        const api = makeApi();
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("logo.png");
        });

        assert.equal(result.current.block, "binary");
        assert.equal(result.current.content, null);
        assert.equal((api.readText as ReturnType<typeof vi.fn>).mock.calls.length, 0);
        assert.equal((api.sizeOf as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    });
});

describe("useFilePreview — unsupported extension", () => {
    it("blocks extensions outside the preview allowlist", async () => {
        const api = makeApi();
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("data.parquet");
        });

        assert.equal(result.current.block, "unsupported");
        assert.equal((api.readText as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    });
});

describe("useFilePreview — too large", () => {
    it("blocks files over MAX_PREVIEW_BYTES without reading content", async () => {
        const api = makeApi({ size: MAX_PREVIEW_BYTES + 1 });
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("big.log");
        });

        assert.equal(result.current.block, "tooLarge");
        assert.equal(result.current.content, null);
        assert.equal((api.readText as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    });
});

describe("useFilePreview — text content", () => {
    it("stores content from readText", async () => {
        const api = makeApi({ text: "hello\nworld" });
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("README.md");
        });

        assert.equal(result.current.block, null);
        assert.equal(result.current.content, "hello\nworld");
    });

    it("previews extension-less files as plain text", async () => {
        const api = makeApi({ text: "MIT License" });
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("LICENSE");
        });

        assert.equal(result.current.block, null);
        assert.equal(result.current.content, "MIT License");
    });
});

describe("useFilePreview — read error", () => {
    it("stores error message on readText throw", async () => {
        const api = makeApi({ throws: true });
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("missing.txt");
        });

        assert.match(result.current.error ?? "", /EACCES/);
        assert.equal(result.current.content, null);
    });
});

describe("useFilePreview — cancellation", () => {
    it("fast A→B→A selection only renders A at end", async () => {
        // Two separate resolvers for "a.txt":
        //   - resolveA[0]: resolves the FIRST select call's pending promise (nonce 1, stale)
        //   - resolveA[1]: resolves the SECOND select call's pending promise (nonce 3, valid)
        // We use an array so each select call gets its own resolver regardless of call order.
        const resolveA: Array<(v: string) => void> = [];
        let resolveB: (s: string) => void = () => {};
        const api: FsClient = {
            readDir: vi.fn(async () => {
                return [];
            }),
            sizeOf: vi.fn(async () => 10),
            readText: vi.fn(async (rel: string) => {
                if (rel === "a.txt") {
                    // Always create a fresh resolver so we can resolve old and new calls independently.
                    const resolvers: Array<(v: string) => void> = [];
                    const p = new Promise<string>((r) => {
                        resolvers.push(r);
                    });
                    resolveA.push(...resolvers);
                    return p;
                }
                const resolveBs: Array<(v: string) => void> = [];
                if (rel === "b.txt") {
                    const p = new Promise<string>((r) => {
                        resolveBs.push(r);
                    });
                    resolveB = resolveBs[0];
                    return p;
                }
                return "";
            }),
        };
        const { result } = renderHook(() => useFilePreview(api));

        // readText sits behind the sizeOf gate, so each select needs a
        // macrotask flush before its resolver registers.
        const flush = () =>
            act(async () => {
                await new Promise((r) => setTimeout(r, 0));
            });

        // ── Step A: A's readText pending → replaced by B ────────────────────
        // Start A (nonce 1); flush so it passes the sizeOf gate and its
        // readText is pending.
        const aPromise = result.current.select("a.txt");
        await flush();
        // Start B (nonce 2) — sets content=null immediately
        const bPromise = result.current.select("b.txt");
        await flush();

        // Resolve A's pending readText (nonce 1 stale vs nonce 2 in flight)
        resolveA[0]("A-stale");
        await act(async () => {
            await aPromise;
        });
        // State unchanged: nonce 1 != nonce 2 → ignored
        assert.equal(result.current.content, null);

        // Resolve B (nonce 2) → content = "B-content"
        resolveB("B-content");
        await act(async () => {
            await bPromise;
        });
        assert.equal(result.current.content, "B-content");

        // ── Step B: A again ─────────────────────────────────────────────────
        // Start A again (nonce 3); flush so its readText is pending.
        const aPromise2 = result.current.select("a.txt");
        await flush();
        // resolveA[0] (nonce 1) is already settled; resolveA[1] belongs to nonce 3.
        // Resolve the stale nonce-1 resolver again — its closure already ran, no-op.
        resolveA[0]("A-old-from-first-select");
        // resolveA[1] resolves the nonce-3 call
        resolveA[1]("A-fresh");
        await act(async () => {
            await aPromise2;
        });
        // Only nonce-3 response sets state
        assert.equal(result.current.content, "A-fresh");
    });
});

describe("useFilePreview.clear", () => {
    it("resets all state", async () => {
        const api = makeApi({ text: "content" });
        const { result } = renderHook(() => useFilePreview(api));

        await act(async () => {
            await result.current.select("a.txt");
        });
        assert.equal(result.current.content, "content");

        act(() => result.current.clear());
        assert.equal(result.current.content, null);
        assert.equal(result.current.selectedRelPath, null);
        assert.equal(result.current.loading, false);
        assert.equal(result.current.block, null);
    });
});
