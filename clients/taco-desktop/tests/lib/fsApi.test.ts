import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveFsPath } from "../../src/lib/fsApi";

describe("resolveFsPath", () => {
    it("returns cwd as-is for empty relPath", () => {
        assert.equal(resolveFsPath("/home/user/proj", ""), "/home/user/proj");
    });

    it("joins cwd and relPath with a single slash", () => {
        assert.equal(
            resolveFsPath("/home/user/proj", "src/index.ts"),
            "/home/user/proj/src/index.ts",
        );
    });

    it("normalizes trailing slash on cwd", () => {
        assert.equal(resolveFsPath("/home/user/proj/", "src"), "/home/user/proj/src");
    });

    it("preserves leading slash on relPath (joins cleanly anyway)", () => {
        assert.equal(
            resolveFsPath("/home/user/proj", "/src/index.ts"),
            "/home/user/proj/src/index.ts",
        );
    });
});
