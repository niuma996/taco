import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveFsPath } from "../../src/lib/clients/fsClient";

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

    it("passes an absolute POSIX path through untouched", () => {
        assert.equal(resolveFsPath("/home/user/proj", "/etc/hosts"), "/etc/hosts");
        assert.equal(
            resolveFsPath("/home/user/proj", "/home/user/proj/src/index.ts"),
            "/home/user/proj/src/index.ts",
        );
    });

    it("passes Windows drive and UNC paths through untouched", () => {
        assert.equal(resolveFsPath("C:/proj", "C:\\other\\file.ts"), "C:\\other\\file.ts");
        assert.equal(resolveFsPath("C:/proj", "\\\\share\\file.ts"), "\\\\share\\file.ts");
    });
});
