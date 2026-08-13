/**
 * projectManifests extension tests.
 *
 * Covers:
 *   - tag spec shape (compression pin, hidden, xml-balanced)
 *   - activator no-ops when no manifest is detected
 *   - activator returns {contextHooks} when matches exist
 *   - hook injects `<project_manifests>` tag with sorted filenames
 *   - hook returns undefined when no manifest is detected (after probe)
 *   - .gitignore suppression of detected matches
 *   - glob patterns handle filename families (`*.csproj`, `build.gradle.kts`)
 *   - IM/extension pipeline filter (see extensions/activation.test.ts)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-agent-core";
import {
    buildProjectManifestsActivator,
    buildProjectManifestsHook,
    getProjectManifestsTagSpec,
} from "../../../src/extensions/builtin/projectManifests/index.ts";

function makeMessages() {
    return [{ role: "user" as const, content: "hello", timestamp: 0 }];
}

describe("builtin project-manifest extension — tag spec", () => {
    it("registers project_manifests as a hidden, pin-compressed, xml-balanced tag", () => {
        const spec = getProjectManifestsTagSpec();
        assert.equal(spec.name, "project_manifests");
        assert.equal(spec.scope, "user-context");
        assert.equal(spec.compression.kind, "pin");
        assert.equal(spec.tuiVisibility, "hidden");
        assert.equal(spec.parser.kind, "xml-balanced");
        assert.ok(spec.description.length > 0);
    });
});

describe("builtin project-manifest extension — activator", () => {
    let empty: string;
    let cargoOnly: string;
    let polyglot: string;
    let csprojDir: string;

    before(() => {
        empty = mkdtempSync(join(tmpdir(), "taco-pm-empty-"));
        cargoOnly = mkdtempSync(join(tmpdir(), "taco-pm-cargo-"));
        writeFileSync(join(cargoOnly, "Cargo.toml"), '[package]\nname = "x"\n');

        polyglot = mkdtempSync(join(tmpdir(), "taco-pm-polyglot-"));
        writeFileSync(join(polyglot, "package.json"), '{"name":"x"}\n');
        writeFileSync(join(polyglot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
        writeFileSync(join(polyglot, "Cargo.toml"), '[package]\nname = "x"\n');

        csprojDir = mkdtempSync(join(tmpdir(), "taco-pm-csproj-"));
        writeFileSync(join(csprojDir, "App.csproj"), "<Project>\n</Project>\n");
        writeFileSync(join(csprojDir, "App.sln"), "Microsoft Visual Studio Solution File\n");
    });

    after(() => {
        for (const d of [empty, cargoOnly, polyglot, csprojDir]) {
            if (d) rmSync(d, { recursive: true, force: true });
        }
    });

    it("returns undefined when no manifest matches", async () => {
        const activator = buildProjectManifestsActivator();
        const result = await activator({ cwd: empty });
        assert.equal(result, undefined);
    });

    it("returns contextHooks when a single manifest matches", async () => {
        const activator = buildProjectManifestsActivator();
        const result = await activator({ cwd: cargoOnly });
        assert.ok(result, "activator must contribute when Cargo.toml is present");
        assert.ok(result?.contextHooks);
        assert.equal(result?.contextHooks.length, 1);
    });

    it("returns sorted, deduplicated filenames for a polyglot workspace", async () => {
        const activator = buildProjectManifestsActivator();
        const result = await activator({ cwd: polyglot });
        assert.ok(result?.contextHooks);
        const hook = buildProjectManifestsHook(polyglot);
        const out = await hook({ messages: makeMessages() } as ContextEvent);
        assert.ok(out, "hook must inject on polyglot workspace");
        // Pull just the bullet list — the guidance text also references
        // `package.json` as an example, which would mislead a naive indexOf.
        const text = JSON.stringify(out?.messages);
        const bullets = text.match(/- [^\n]+/g) ?? [];
        const bulletsText = bullets.join("\n");
        assert.match(bulletsText, /- Cargo\.toml/);
        assert.match(bulletsText, /- package\.json/);
        assert.match(bulletsText, /- pnpm-workspace\.yaml/);
        // Sorted alphabetically: Cargo.toml < package.json < pnpm-workspace.yaml
        const idxCargo = bulletsText.indexOf("Cargo.toml");
        const idxPkg = bulletsText.indexOf("package.json");
        const idxPnpm = bulletsText.indexOf("pnpm-workspace.yaml");
        assert.ok(
            idxCargo < idxPkg && idxPkg < idxPnpm,
            `filenames must be sorted, got: ${bulletsText}`,
        );
    });

    it("matches glob patterns for filename families", async () => {
        const activator = buildProjectManifestsActivator();
        const result = await activator({ cwd: csprojDir });
        assert.ok(result, "activator must contribute when *.csproj / *.sln match");
        const hook = buildProjectManifestsHook(csprojDir);
        const out = await hook({ messages: makeMessages() } as ContextEvent);
        const text = JSON.stringify(out?.messages);
        assert.match(text, /App\.csproj/);
        assert.match(text, /App\.sln/);
    });

    it("suppresses matches that .gitignore excludes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "taco-pm-ignore-"));
        writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
        writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
        writeFileSync(join(dir, ".gitignore"), "Cargo.toml\n");
        try {
            const hook = buildProjectManifestsHook(dir);
            const out = await hook({ messages: makeMessages() } as ContextEvent);
            const text = JSON.stringify(out?.messages);
            assert.match(text, /package\.json/);
            assert.ok(!text.includes("Cargo.toml"), "gitignored manifest must not be reported");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("builtin project-manifest extension — hook", () => {
    let empty: string;
    let withManifest: string;

    before(() => {
        empty = mkdtempSync(join(tmpdir(), "taco-pm-hook-empty-"));
        withManifest = mkdtempSync(join(tmpdir(), "taco-pm-hook-yes-"));
        writeFileSync(join(withManifest, "package.json"), '{"name":"x"}\n');
    });

    after(() => {
        if (empty) rmSync(empty, { recursive: true, force: true });
        if (withManifest) rmSync(withManifest, { recursive: true, force: true });
    });

    it("returns undefined when no manifest is detected", async () => {
        const hook = buildProjectManifestsHook(empty);
        const result = await hook({ messages: makeMessages() } as ContextEvent);
        assert.equal(result, undefined);
    });

    it("prepends a <project_manifests> tag with inline guidance", async () => {
        const hook = buildProjectManifestsHook(withManifest);
        const result = await hook({ messages: makeMessages() } as ContextEvent);
        assert.ok(result, "hook must inject on package.json workspace");
        const messages = result?.messages ?? [];
        assert.ok(messages.length >= 2, "tag prepended + original message");
        const first = messages[0] as { content: Array<{ text?: string }> };
        const tagText = first.content[0]?.text ?? "";
        assert.match(tagText, /<project_manifests>/);
        assert.match(tagText, /package\.json/);
        assert.match(tagText, /Do NOT fetch the files' contents unprompted/);
    });
});
