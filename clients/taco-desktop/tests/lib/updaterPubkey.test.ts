/**
 * Guards the updater trust anchor embedded in tauri.conf.json.
 *
 * `plugins.updater.pubkey` must be base64 of the ENTIRE minisign `.pub` file
 * (both text lines), because tauri-plugin-updater base64-decodes the field and
 * requires the result to be UTF-8 before handing it to minisign's
 * `PublicKey::decode`. Embedding just the second line — the raw 42-byte key
 * blob — decodes to binary, is rejected, and makes every update fail with
 * "The signature <pubkey> could not be decoded ..." before any signature is
 * examined. Format only; the key material itself lives with the operator.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** Mirrors the updater's `base64_to_string` + `PublicKey::decode` pair. */
function assertValidPubkey(value: string): void {
    const decoded = Buffer.from(value, "base64");
    assert.ok(
        Buffer.from(decoded.toString("utf8"), "utf8").equals(decoded),
        "pubkey must base64-decode to UTF-8 (i.e. to the .pub file text, not the key blob)",
    );

    const [comment, key] = decoded.toString("utf8").split("\n");
    assert.match(comment, /^untrusted comment: minisign public key [0-9A-F]+$/, "bad .pub header");
    assert.ok(key, "expected a second line carrying the key");

    const blob = Buffer.from(key, "base64");
    assert.equal(blob.length, 42, "a minisign public key blob is 42 bytes");
    assert.ok(
        ["Ed", "ED"].includes(blob.subarray(0, 2).toString("ascii")),
        "expected the Ed25519 algorithm tag",
    );
}

describe("updater pubkey", () => {
    it("rejects the bare key blob, the shape 0.2.3 shipped", () => {
        assert.throws(
            () => assertValidPubkey("RWR51OP0ywcYbPZFnhGv6JAyVdpPHDk0x9q0xtt/5Bx7+ZNM4YFA4u0D"),
            /base64-decode to UTF-8/,
        );
    });

    it("accepts the key embedded in tauri.conf.json", () => {
        const config = JSON.parse(
            readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
        ) as { plugins?: { updater?: { pubkey?: string } } };

        const pubkey = config.plugins?.updater?.pubkey;
        assert.ok(pubkey, "plugins.updater.pubkey is missing");
        assertValidPubkey(pubkey);
    });
});
