import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    ALWAYS_HIDE_NAMES,
    BINARY_EXTENSIONS,
    filterEntries,
    isBinary,
    sortEntries,
    TEXT_TRUNCATE_BYTES,
} from "../../src/lib/fileTypes";

describe("ALWAYS_HIDE_NAMES", () => {
    it("contains common build / cache dirs", () => {
        for (const name of ["node_modules", ".git", "dist", "build", ".next", "out", "coverage"]) {
            assert.ok(ALWAYS_HIDE_NAMES.has(name), `expected ${name} in hide set`);
        }
    });
});

describe("BINARY_EXTENSIONS", () => {
    it("contains common image / archive / binary exts", () => {
        for (const ext of ["png", "jpg", "pdf", "zip", "tar", "exe", "dylib", "wasm"]) {
            assert.ok(BINARY_EXTENSIONS.has(ext), `expected ${ext} in binary set`);
        }
    });
});

describe("TEXT_TRUNCATE_BYTES", () => {
    it("is 2 MiB", () => {
        assert.equal(TEXT_TRUNCATE_BYTES, 2 * 1024 * 1024);
    });
});

describe("isBinary", () => {
    it("returns true for known binary extensions (case-insensitive)", () => {
        assert.equal(isBinary("foo.PNG"), true);
        assert.equal(isBinary("bar.exe"), true);
        assert.equal(isBinary("baz.Zip"), true);
    });
    it("returns false for text-like extensions", () => {
        assert.equal(isBinary("foo.ts"), false);
        assert.equal(isBinary("README.md"), false);
        assert.equal(isBinary("Makefile"), false);
    });
    it("returns false when no extension", () => {
        assert.equal(isBinary("LICENSE"), false);
    });
});

describe("filterEntries", () => {
    const entries = [
        { relPath: "node_modules", name: "node_modules", kind: "dir" as const, size: -1 },
        { relPath: "src", name: "src", kind: "dir" as const, size: -1 },
        { relPath: ".env", name: ".env", kind: "file" as const, size: 10 },
        { relPath: "README.md", name: "README.md", kind: "file" as const, size: 100 },
        { relPath: ".gitignore", name: ".gitignore", kind: "file" as const, size: 50 },
    ];

    it("hides entries in ALWAYS_HIDE_NAMES", () => {
        const out = filterEntries(entries, { showHidden: false });
        assert.ok(!out.some((e) => e.name === "node_modules"));
    });

    it("hides dotfiles when showHidden=false", () => {
        const out = filterEntries(entries, { showHidden: false });
        assert.ok(!out.some((e) => e.name === ".env"));
        assert.ok(!out.some((e) => e.name === ".gitignore"));
    });

    it("shows dotfiles when showHidden=true", () => {
        const out = filterEntries(entries, { showHidden: true });
        assert.ok(out.some((e) => e.name === ".env"));
        assert.ok(out.some((e) => e.name === ".gitignore"));
    });

    it("still hides ALWAYS_HIDE_NAMES even when showHidden=true", () => {
        const out = filterEntries(entries, { showHidden: true });
        assert.ok(!out.some((e) => e.name === "node_modules"));
    });
});

describe("sortEntries", () => {
    it("puts dirs first, then files, each alphabetical case-insensitive", () => {
        const out = sortEntries([
            { relPath: "zeta.txt", name: "zeta.txt", kind: "file", size: 1 },
            { relPath: "Apple", name: "Apple", kind: "dir", size: -1 },
            { relPath: "banana.txt", name: "banana.txt", kind: "file", size: 1 },
            { relPath: "Cherry", name: "Cherry", kind: "dir", size: -1 },
        ]);
        assert.deepEqual(
            out.map((e) => e.name),
            ["Apple", "Cherry", "banana.txt", "zeta.txt"],
        );
    });
});
