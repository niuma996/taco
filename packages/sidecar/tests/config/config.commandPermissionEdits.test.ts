import assert from "node:assert/strict";
import { it } from "node:test";
import { saveGlobalConfig } from "../../src/config/config.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("permission-edits");
it("applies permission edits to the latest disk lists without restoring stale rules", () => {
    saveGlobalConfig({
        commandPermissions: {
            mode: "ask",
            allow: ["git diff"],
            deny: ["git reset *"],
            allowedDirectories: ["/workspace"],
        },
    });
    saveGlobalConfig({ commandPermissionsEdit: { addAllow: ["pnpm test"] } });
    saveGlobalConfig({ commandPermissionsEdit: { addDeny: ["git push *"] } });
    const next = saveGlobalConfig({
        commandPermissionsEdit: { mode: "auto", removeAllow: ["git diff"] },
    });
    assert.deepEqual(next.commandPermissions, {
        mode: "auto",
        allow: ["pnpm test"],
        deny: ["git reset *", "git push *"],
        allowedDirectories: ["/workspace"],
    });
});
it("rejects malformed edits without changing disk configuration", () => {
    const before = saveGlobalConfig({ commandPermissions: { mode: "ask", allow: [], deny: [] } });
    assert.throws(() =>
        saveGlobalConfig({ commandPermissionsEdit: { addDeny: "git *" } } as never),
    );
    assert.throws(() => saveGlobalConfig({ commandPermissionsEdit: { mode: "unsafe" } } as never));
    assert.deepEqual(saveGlobalConfig({}).commandPermissions, before.commandPermissions);
});
