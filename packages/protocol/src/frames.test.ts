import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    isCompatibleClientProtocol,
    isCompatibleSidecarProtocol,
    SIDECAR_PROTOCOL_VERSION,
} from "./index.js";

describe("sidecar hello contract", () => {
    it("declares the current protocol version", () => {
        assert.deepEqual(SIDECAR_PROTOCOL_VERSION, { major: 1, minor: 0 });
    });

    it("rejects a major mismatch in either direction", () => {
        assert.equal(isCompatibleSidecarProtocol({ major: 0, minor: 9 }), false);
        assert.equal(isCompatibleSidecarProtocol({ major: 2, minor: 0 }), false);
    });

    it("accepts an equal or newer sidecar minor (additive)", () => {
        assert.equal(isCompatibleSidecarProtocol({ major: 1, minor: 0 }), true);
        assert.equal(isCompatibleSidecarProtocol({ major: 1, minor: 4 }), true);
    });

    it("rejects an older sidecar minor (client may call missing methods)", () => {
        assert.equal(isCompatibleSidecarProtocol({ major: 1, minor: -1 }), false);
    });

    it("rejects a missing or malformed minor", () => {
        assert.equal(isCompatibleSidecarProtocol({ major: 1, minor: undefined }), false);
        assert.equal(isCompatibleSidecarProtocol({ major: 1, minor: "0" }), false);
        assert.equal(isCompatibleSidecarProtocol({ major: 1, minor: null }), false);
    });
});

describe("isCompatibleClientProtocol (server-side gate)", () => {
    it("rejects a major mismatch in either direction", () => {
        assert.equal(isCompatibleClientProtocol({ major: 0, minor: 9 }), false);
        assert.equal(isCompatibleClientProtocol({ major: 2, minor: 0 }), false);
    });

    it("accepts an equal or older client minor", () => {
        assert.equal(isCompatibleClientProtocol({ major: 1, minor: 0 }), true);
    });

    it("rejects a newer client minor (server cannot honour unknown methods)", () => {
        assert.equal(isCompatibleClientProtocol({ major: 1, minor: 1 }), false);
        assert.equal(isCompatibleClientProtocol({ major: 1, minor: 4 }), false);
    });

    it("rejects a missing or malformed minor", () => {
        assert.equal(isCompatibleClientProtocol({ major: 1, minor: undefined }), false);
        assert.equal(isCompatibleClientProtocol({ major: 1, minor: "0" }), false);
        assert.equal(isCompatibleClientProtocol({ major: 1, minor: null }), false);
    });
});

describe("initialize handshake contract", () => {
    it("ClientCapabilities accepts uiLocale and arbitrary future fields", () => {
        const caps = {
            uiLocale: "zh",
            experimentalFlag: true,
            nested: { a: 1 },
        };
        assert.equal(caps.uiLocale, "zh");
        assert.equal(caps.experimentalFlag, true);
    });

    it("InitializeParams carries protocolVersion + clientCapabilities", () => {
        const params = {
            protocolVersion: { major: 1, minor: 0 },
            clientCapabilities: { uiLocale: "en" as const },
        };
        assert.equal(params.protocolVersion.major, 1);
        assert.equal(params.protocolVersion.minor, 0);
        assert.equal(params.clientCapabilities.uiLocale, "en");
    });

    it("InitializeResult carries serverVersion, serverCapabilities, protocolVersion", () => {
        const result = {
            serverVersion: "1.0.0",
            serverCapabilities: {
                methods: ["initialize"],
                pushes: ["sidecar.hello"],
            },
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
        };
        assert.equal(result.serverVersion, "1.0.0");
        assert.deepEqual(result.serverCapabilities.methods, ["initialize"]);
        assert.equal(result.protocolVersion.minor, 0);
    });
});
