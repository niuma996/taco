/**
 * file:// URL construction for local paths.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fileUrl } from "../../src/lib/fileUrl";

describe("fileUrl", () => {
    it("keeps a plain absolute path readable", () => {
        assert.equal(fileUrl("/Users/me/report.html"), "file:///Users/me/report.html");
    });

    it("percent-encodes spaces and non-ascii names", () => {
        assert.equal(
            fileUrl("/Users/me/阳朔 5天.html"),
            "file:///Users/me/%E9%98%B3%E6%9C%94%205%E5%A4%A9.html",
        );
    });

    it("keeps a dot-leading directory component", () => {
        assert.equal(
            fileUrl("/Users/me/.taco/workspace/plan.html"),
            "file:///Users/me/.taco/workspace/plan.html",
        );
    });

    it("turns a windows path into a rooted file url", () => {
        assert.equal(fileUrl("C:\\Users\\me\\a.html"), "file:///C:/Users/me/a.html");
    });
});
