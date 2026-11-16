import assert from "node:assert/strict";
import { test } from "node:test";
import {
    extensionConfigEnumNames,
    extensionConfigFields,
    extensionConfigText,
} from "@taco-ai/protocol";
import { initialPluginDraft, pluginConfigPatch } from "../../src/views/pluginConfigForm";

test("plugin fields support primitive enums, locale fallback and ignore complex fields", () => {
    const schema = {
        type: "object",
        properties: {
            mode: {
                type: "string",
                enum: ["", "full"],
                "x-i18n": { zh: { title: "模式", enumNames: ["无", "完整"] } },
            },
            nested: { type: "object" },
        },
    };
    const fields = extensionConfigFields(schema);
    assert.equal(fields.length, 1);
    const field = fields[0];
    assert.ok(field);
    assert.equal(extensionConfigText(field.schema, "zh-CN", "title"), "模式");
    assert.deepEqual(extensionConfigEnumNames(field.schema, "zh-CN"), ["无", "完整"]);
    const draft = initialPluginDraft(fields, {
        schema,
        values: { mode: "" },
        configuredSecrets: [],
        pendingRestart: false,
    });
    const patch = pluginConfigPatch(fields, draft, new Set(["mode"]), new Set());
    assert.equal(patch.values.mode, "");
    assert.deepEqual(patch.unset, []);
});

test("required fields cannot be unset", () => {
    const fields = extensionConfigFields({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
    });
    const patch = pluginConfigPatch(fields, { name: "" }, new Set(["name"]), new Set());
    assert.equal(patch.errors.name, "plugins.configInvalid");
});
