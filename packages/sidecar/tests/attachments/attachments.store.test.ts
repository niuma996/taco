import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_STAGE_INLINE_MAX_BYTES } from "@taco-ai/protocol";

import {
    ATTACHMENT_STAGING_TTL_MS,
    AttachmentError,
    commitAttachments,
    safeFileName,
    stageFromData,
    stageFromPath,
    stagingRoot,
    sweepStaging,
} from "../../src/attachments/attachmentStore.ts";
import {
    detectMimeType,
    isModelImageMime,
    sniffImageMime,
} from "../../src/attachments/mimeType.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("attachments");

const WS = "/work/alpha";
const OTHER_WS = "/work/beta";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Buffer.from("GIF89a000000", "latin1");
const WEBP = Buffer.from("RIFF0000WEBP", "latin1");

describe("safeFileName", () => {
    it("keeps only the final path component", () => {
        assert.equal(safeFileName("/a/b/report.pdf"), "report.pdf");
        assert.equal(safeFileName("../../etc/passwd"), "passwd");
        assert.equal(safeFileName("C:\\Users\\me\\notes.txt"), "notes.txt");
    });

    it("never returns an empty name or a dot segment", () => {
        for (const raw of ["", "   ", ".", "..", "/", "a/.."]) {
            const name = safeFileName(raw);
            assert.notEqual(name, "");
            assert.notEqual(name, ".");
            assert.notEqual(name, "..");
        }
    });

    it("replaces control characters and reserved characters", () => {
        assert.equal(safeFileName("a\u0000b\nc:d.txt"), "a_b_c_d.txt");
    });

    it("bounds the length and keeps the extension", () => {
        const name = safeFileName(`${"x".repeat(400)}.pdf`);
        assert.ok(name.length <= 120);
        assert.ok(name.endsWith(".pdf"));
    });
});

describe("mime detection", () => {
    it("sniffs the raster formats models accept", () => {
        assert.equal(sniffImageMime(PNG), "image/png");
        assert.equal(sniffImageMime(JPEG), "image/jpeg");
        assert.equal(sniffImageMime(GIF), "image/gif");
        assert.equal(sniffImageMime(WEBP), "image/webp");
        assert.equal(sniffImageMime(Buffer.from("hello world!!!!")), undefined);
    });

    it("treats SVG and BMP as plain files, not model images", () => {
        assert.equal(isModelImageMime("image/svg+xml"), false);
        assert.equal(isModelImageMime("image/bmp"), false);
        assert.equal(isModelImageMime("image/png"), true);
    });

    describe("on disk", () => {
        let dir: string;
        before(async () => {
            dir = await mkdtemp(join(tmpdir(), "taco-mime-"));
        });
        after(async () => {
            await rm(dir, { recursive: true, force: true });
        });

        it("decides from the bytes, not the name or the declared type", async () => {
            const png = join(dir, "no-extension");
            await writeFile(png, PNG);
            assert.equal(await detectMimeType(png, undefined, "no-extension"), "image/png");

            const fake = join(dir, "fake.png");
            await writeFile(fake, "MZ this is not an image");
            assert.equal(
                await detectMimeType(fake, "image/png", "fake.png"),
                "application/octet-stream",
                "a declared or named image that the bytes do not confirm is not an image",
            );
        });

        it("labels non-images from the extension, then a non-image declared type", async () => {
            const pdf = join(dir, "doc.PDF");
            await writeFile(pdf, "%PDF-1.7");
            assert.equal(await detectMimeType(pdf, undefined, "doc.PDF"), "application/pdf");

            const odd = join(dir, "data.bin");
            await writeFile(odd, "x");
            assert.equal(
                await detectMimeType(odd, "application/x-custom", "data.bin"),
                "application/x-custom",
            );
        });
    });
});

describe("staging", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "taco-stage-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("copies a file and reports kind from the bytes", async () => {
        const src = join(dir, "shot.png");
        await writeFile(src, PNG);
        const r = await stageFromPath(WS, src);
        assert.equal(r.name, "shot.png");
        assert.equal(r.mimeType, "image/png");
        assert.equal(r.kind, "image");
        assert.equal(r.size, PNG.length);
        assert.deepEqual(await readFile(join(stagingRoot(WS), r.id, "shot.png")), PNG);
    });

    it("pins content at stage time", async () => {
        const src = join(dir, "pinned.txt");
        await writeFile(src, "before");
        const r = await stageFromPath(WS, src);
        await writeFile(src, "after");
        assert.equal(await readFile(join(stagingRoot(WS), r.id, "pinned.txt"), "utf8"), "before");
    });

    it("stages inline data and defaults to a file kind for text", async () => {
        const r = await stageFromData(
            WS,
            "note.md",
            Buffer.from("# hi").toString("base64"),
            undefined,
        );
        assert.equal(r.kind, "file");
        assert.equal(r.mimeType, "text/markdown");
        assert.equal(r.size, 4);
    });

    it("sniffs a pasted screenshot that has no name", async () => {
        const r = await stageFromData(WS, "image", PNG.toString("base64"), undefined);
        assert.equal(r.kind, "image");
    });

    it("refuses a missing path and a directory", async () => {
        await assert.rejects(
            stageFromPath(WS, join(dir, "nope")),
            (e: unknown) => e instanceof AttachmentError && e.code === "not_found",
        );
        await assert.rejects(
            stageFromPath(WS, dir),
            (e: unknown) => e instanceof AttachmentError && e.code === "not_a_file",
        );
    });

    it("refuses an oversized inline body without writing anything", async () => {
        const before = existsSync(stagingRoot(WS)) ? (await readdir(stagingRoot(WS))).length : 0;
        const big = Buffer.alloc(ATTACHMENT_STAGE_INLINE_MAX_BYTES + 1).toString("base64");
        await assert.rejects(
            stageFromData(WS, "big.bin", big, undefined),
            (e: unknown) => e instanceof AttachmentError && e.code === "too_large",
        );
        const after = existsSync(stagingRoot(WS)) ? (await readdir(stagingRoot(WS))).length : 0;
        assert.equal(after, before);
    });

    it("refuses an oversized file by its size on disk", async () => {
        const src = join(dir, "huge.bin");
        await writeFile(src, "");
        // A sparse file reports the full size without writing it.
        const { truncate } = await import("node:fs/promises");
        await truncate(src, ATTACHMENT_MAX_BYTES + 1);
        await assert.rejects(
            stageFromPath(WS, src),
            (e: unknown) => e instanceof AttachmentError && e.code === "too_large",
        );
    });

    it("follows a symlink source to its content and records the link's name", async () => {
        const target = join(dir, "real.txt");
        await writeFile(target, "real");
        const link = join(dir, "link.txt");
        await symlink(target, link);
        const r = await stageFromPath(WS, link);
        assert.equal(r.name, "link.txt");
        assert.equal(await readFile(join(stagingRoot(WS), r.id, "link.txt"), "utf8"), "real");
    });

    it("keeps the staged copy and its directory owner-only", async () => {
        if (process.platform === "win32") return;
        const src = join(dir, "world-readable.txt");
        await writeFile(src, "secret", { mode: 0o644 });
        const r = await stageFromPath(WS, src);
        const fileMode = (await stat(join(stagingRoot(WS), r.id, "world-readable.txt"))).mode;
        const dirMode = (await stat(join(stagingRoot(WS), r.id))).mode;
        assert.equal(fileMode & 0o777, 0o600, "a copy is never more readable than owner-only");
        assert.equal(dirMode & 0o777, 0o700);
    });
});

describe("commit", () => {
    let root: string;
    before(async () => {
        root = await mkdtemp(join(tmpdir(), "taco-sessions-"));
    });
    after(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("moves staged files into the session directory and empties staging", async () => {
        const a = await stageFromData(WS, "a.txt", Buffer.from("A").toString("base64"), undefined);
        const b = await stageFromData(WS, "b.png", PNG.toString("base64"), undefined);
        const out = await commitAttachments([a.id, b.id], WS, root, "sess-1");

        assert.equal(out.length, 2);
        assert.equal(out[0]?.path, join(root, "sess-1", "attachments", `${a.id}-a.txt`));
        assert.equal(out[1]?.kind, "image");
        assert.equal(await readFile(out[0]?.path ?? "", "utf8"), "A");
        assert.equal(existsSync(join(stagingRoot(WS), a.id)), false);
        assert.equal(existsSync(join(stagingRoot(WS), b.id)), false);
    });

    it("dedupes repeated ids", async () => {
        const a = await stageFromData(
            WS,
            "dup.txt",
            Buffer.from("D").toString("base64"),
            undefined,
        );
        const out = await commitAttachments([a.id, a.id], WS, root, "sess-dup");
        assert.equal(out.length, 1);
    });

    it("rejects an id that is not a minted uuid before touching any path", async () => {
        for (const bad of ["../x", "a/b", "", "not-a-uuid"]) {
            await assert.rejects(
                commitAttachments([bad], WS, root, "sess-bad"),
                (e: unknown) => e instanceof AttachmentError && e.code === "bad_id",
            );
        }
        assert.equal(existsSync(join(root, "sess-bad")), false);
    });

    it("is all-or-nothing: one missing id leaves the others staged", async () => {
        const ok = await stageFromData(
            WS,
            "keep.txt",
            Buffer.from("K").toString("base64"),
            undefined,
        );
        const missing = "00000000-0000-4000-8000-000000000000";
        await assert.rejects(
            commitAttachments([ok.id, missing], WS, root, "sess-partial"),
            (e: unknown) => e instanceof AttachmentError && e.code === "not_found",
        );
        assert.equal(existsSync(join(stagingRoot(WS), ok.id)), true, "still staged");
        assert.equal(existsSync(join(root, "sess-partial", "attachments")), false);
    });

    it("returns nothing for no ids", async () => {
        assert.deepEqual(await commitAttachments([], WS, root, "sess-none"), []);
    });

    it("will not commit an id staged by another workspace", async () => {
        const a = await stageFromData(
            WS,
            "mine.txt",
            Buffer.from("M").toString("base64"),
            undefined,
        );
        await assert.rejects(
            commitAttachments([a.id], OTHER_WS, root, "sess-other"),
            (e: unknown) => e instanceof AttachmentError && e.code === "not_found",
        );
        assert.equal(existsSync(join(stagingRoot(WS), a.id)), true, "still staged for its own");
    });

    it("commits owner-only files into an owner-only directory", async () => {
        if (process.platform === "win32") return;
        const a = await stageFromData(WS, "k.txt", Buffer.from("K").toString("base64"), undefined);
        const [out] = await commitAttachments([a.id], WS, root, "sess-perm");
        assert.equal((await stat(out?.path ?? "")).mode & 0o777, 0o600);
        const dirMode = (await stat(join(root, "sess-perm", "attachments"))).mode;
        assert.equal(dirMode & 0o777, 0o700);
    });
});

describe("sweepStaging", () => {
    it("removes only directories older than the TTL", async () => {
        const fresh = await stageFromData(
            WS,
            "fresh.txt",
            Buffer.from("f").toString("base64"),
            undefined,
        );
        const stale = await stageFromData(
            WS,
            "stale.txt",
            Buffer.from("s").toString("base64"),
            undefined,
        );
        const old = new Date(Date.now() - ATTACHMENT_STAGING_TTL_MS - 60_000);
        await utimes(join(stagingRoot(WS), stale.id), old, old);

        const removed = await sweepStaging();
        assert.ok(removed >= 1);
        assert.equal(existsSync(join(stagingRoot(WS), stale.id)), false);
        assert.equal(existsSync(join(stagingRoot(WS), fresh.id)), true);
        assert.ok((await stat(join(stagingRoot(WS), fresh.id))).isDirectory());
    });

    it("is a no-op when nothing was ever staged", async () => {
        const dir = await mkdtemp(join(tmpdir(), "taco-empty-"));
        const prev = process.env.TACO_HOME;
        process.env.TACO_HOME = dir;
        try {
            assert.equal(await sweepStaging(), 0);
            await mkdir(join(dir, "staging"), { recursive: true });
            assert.equal(await sweepStaging(), 0);
        } finally {
            process.env.TACO_HOME = prev;
            await rm(dir, { recursive: true, force: true });
        }
    });
});
