import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { writeJsonAtomic, writeTextAtomic } from "../../src/store/atomicFile.ts";

describe("atomicFile", () => {
    async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
        const dir = await mkdtemp(join(tmpdir(), "taco-atomic-test-"));
        try {
            return await fn(dir);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    test("writeJsonAtomic round-trips an object", async () => {
        await withTmp(async (dir) => {
            const path = join(dir, "doc.json");
            await writeJsonAtomic(path, { id: "a", n: 1 });
            strictEqual(await readFile(path, "utf8"), '{"id":"a","n":1}');
        });
    });

    test("indent pretty-prints with the requested width", async () => {
        await withTmp(async (dir) => {
            const path = join(dir, "doc.json");
            await writeJsonAtomic(path, { id: "a" }, { indent: 2 });
            strictEqual(await readFile(path, "utf8"), '{\n  "id": "a"\n}');
        });
    });

    test("overwriting leaves no temp file behind", async () => {
        await withTmp(async (dir) => {
            const path = join(dir, "doc.json");
            await writeJsonAtomic(path, { v: 1 });
            await writeJsonAtomic(path, { v: 2 });
            deepStrictEqual(await readdir(dir), ["doc.json"]);
            deepStrictEqual(JSON.parse(await readFile(path, "utf8")), { v: 2 });
        });
    });

    test("concurrent writes to one path do not collide", async () => {
        await withTmp(async (dir) => {
            const path = join(dir, "doc.json");
            await Promise.all(
                Array.from({ length: 20 }, (_, index) => writeJsonAtomic(path, { index })),
            );
            const survivor = JSON.parse(await readFile(path, "utf8")) as { index: number };
            ok(survivor.index >= 0 && survivor.index < 20);
            deepStrictEqual(await readdir(dir), ["doc.json"]);
        });
    });

    test("secure writes are owner-only on unix", {
        skip: process.platform === "win32",
    }, async () => {
        await withTmp(async (dir) => {
            const path = join(dir, "doc.json");
            await writeJsonAtomic(path, { secret: true }, { secure: true });
            const mode = (await stat(path)).mode & 0o777;
            strictEqual(mode, 0o600);
        });
    });

    test("a write into a missing directory rejects and cleans up nothing", async () => {
        await withTmp(async (dir) => {
            const path = join(dir, "missing", "doc.json");
            await rejects(writeTextAtomic(path, "x"), /ENOENT/);
        });
    });
});
