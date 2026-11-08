import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { StagedAttachment } from "../../../src/lib/attachments";
import {
    ConversationDrafts,
    type ConversationTarget,
} from "../../../src/lib/chat/conversationDrafts";

const a: ConversationTarget = { kind: "session", workspace: "/a", sessionId: "same" };
const b: ConversationTarget = { kind: "session", workspace: "/b", sessionId: "same" };
const draft: ConversationTarget = { kind: "draft", workspace: "/a", draftId: "same" };
function file(id: string, previewUrl = `blob:${id}`): StagedAttachment {
    return { id, name: id, kind: "image", mimeType: "image/png", size: 1, previewUrl };
}

describe("ConversationDrafts", () => {
    it("prepares snapshots without owning a target or pinning its initial model", () => {
        const manager = new ConversationDrafts();
        let changes = 0;
        manager.subscribe(() => {
            changes++;
        });
        const abandoned = manager.prepare(a, { provider: "test", id: "abandoned" });
        assert.equal(abandoned.getSnapshot().selectedModel?.id, "abandoned");
        manager.release(a);
        assert.equal(changes, 0, "preparation must not leave a releasable entry");
        const committed = manager.bind(a, { provider: "test", id: "committed" });
        assert.equal(committed.getSnapshot().selectedModel?.id, "committed");
    });

    it("lazily captures early events and follows migration before its commit effect", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const prepared = manager.prepare(draft, { provider: "test", id: "chosen" });
        prepared.setInput("early");
        const submission = prepared.beginSubmission();
        prepared.setInput("");
        manager.migrateDraft("/a", "same", "same");
        prepared.commit();
        prepared.setAttachments([file("late")]);
        manager.completeSubmission(submission, false);
        const session = manager.bind(a);
        assert.equal(session.getSnapshot().input, "early");
        assert.equal(session.getSnapshot().selectedModel?.id, "chosen");
        assert.deepEqual(session.getSnapshot().attachments, [file("late")]);
        manager.migrateDraft("/a", "same", "same");
        manager.bind(draft).setInput("late bind");
        assert.equal(session.getSnapshot().input, "late bind");
        manager.release(a);
        prepared.setAttachments([file("released")]);
        assert.deepEqual(revoked, ["blob:late", "blob:released"]);
        assert.deepEqual(prepared.getSnapshot().attachments, []);
    });

    it("isolates workspaces and session/draft namespaces", () => {
        const manager = new ConversationDrafts();
        const first = manager.bind(a);
        first.setInput("A");
        first.setAttachments([file("a")]);
        manager.bind(b).setInput("B");
        manager.bind(draft).setInput("draft");
        assert.equal(manager.bind(a).getSnapshot().input, "A");
        assert.deepEqual(first.getSnapshot().attachments, [file("a")]);
        assert.equal(manager.bind(b).getSnapshot().input, "B");
        assert.equal(manager.bind(draft).getSnapshot().input, "draft");
    });

    it("supports synchronous functional updates and captures an independent snapshot", () => {
        const handle = new ConversationDrafts().bind(a);
        handle.setInput("hello");
        handle.setInput((prev) => `${prev}!`);
        handle.setAttachments([file("one")]);
        const submission = handle.beginSubmission();
        handle.setAttachments((prev) => [...prev, file("two")]);
        assert.equal(submission.input, "hello!");
        assert.deepEqual(submission.attachments, [file("one")]);
        assert.equal(handle.getSnapshot().revision, submission.revision + 1);
    });

    it("clears a successful snapshot without touching another target", () => {
        const manager = new ConversationDrafts();
        const first = manager.bind(a);
        first.setInput("A");
        first.setAttachments([file("a")]);
        const submission = first.beginSubmission();
        manager.bind(b).setInput("B");
        manager.completeSubmission(submission, true);
        assert.equal(first.getSnapshot().input, "");
        assert.deepEqual(first.getSnapshot().attachments, []);
        assert.equal(manager.bind(b).getSnapshot().input, "B");
    });

    it("preserves newer text and files when an older send succeeds", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("sent");
        handle.setAttachments([file("sent")]);
        const submission = handle.beginSubmission();
        handle.setInput("new input");
        handle.setAttachments((prev) => [...prev, file("later")]);
        manager.completeSubmission(submission, true);
        assert.equal(handle.getSnapshot().input, "new input");
        assert.deepEqual(handle.getSnapshot().attachments, [file("later")]);
    });

    it("does not clear edited text even if it equals the submitted text again", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("same");
        const submission = handle.beginSubmission();
        handle.setInput("different");
        handle.setInput("same");
        manager.completeSubmission(submission, true);
        assert.equal(handle.getSnapshot().input, "same");
    });

    it("clears unchanged text when only a later attachment changed", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("sent");
        const submission = handle.beginSubmission();
        handle.setAttachments([file("later")]);
        manager.completeSubmission(submission, true);
        assert.equal(handle.getSnapshot().input, "");
        assert.deepEqual(handle.getSnapshot().attachments, [file("later")]);
    });

    it("restores a failed optimistic clear to its origin", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("restore me");
        handle.setAttachments([file("original")]);
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setAttachments([]);
        manager.bind(b).setInput("keep B");
        manager.completeSubmission(submission, false);
        assert.equal(handle.getSnapshot().input, "restore me");
        assert.deepEqual(handle.getSnapshot().attachments, [file("original")]);
        assert.deepEqual(handle.getSnapshot().recoveries, []);
        assert.equal(manager.bind(b).getSnapshot().input, "keep B");
    });

    it("retains a failed overwritten snapshot for explicit recovery", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("failed");
        handle.setAttachments([file("failed")]);
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setAttachments([]);
        handle.setInput("new draft");
        handle.setAttachments([file("new")]);
        manager.completeSubmission(submission, false);
        assert.equal(handle.getSnapshot().input, "new draft");
        assert.deepEqual(handle.getSnapshot().attachments, [file("new")]);
        const [recovery] = handle.getSnapshot().recoveries;
        assert.ok(recovery);
        assert.equal(recovery.input, "failed");
        handle.recoverSubmission(recovery.id);
        assert.equal(handle.getSnapshot().input, "failed\nnew draft");
        assert.deepEqual(handle.getSnapshot().attachments, [file("failed"), file("new")]);
        assert.deepEqual(handle.getSnapshot().recoveries, []);
    });

    it("does not restore into text that was edited and then erased", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("failed");
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setInput("new");
        handle.setInput("");
        manager.completeSubmission(submission, false);
        assert.equal(handle.getSnapshot().input, "");
        assert.equal(handle.getSnapshot().recoveries.length, 1);
    });

    it("leaves an uncleared failed submission in place without a duplicate recovery", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("still here");
        handle.setAttachments([file("here")]);
        manager.completeSubmission(handle.beginSubmission(), false);
        assert.equal(handle.getSnapshot().input, "still here");
        assert.deepEqual(handle.getSnapshot().attachments, [file("here")]);
        assert.deepEqual(handle.getSnapshot().recoveries, []);
    });

    it("retains an unknown cleared submission without automatically restoring the composer", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const handle = manager.bind(a);
        handle.setInput("possibly sent");
        handle.setAttachments([file("uncertain")]);
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setAttachments([]);
        manager.completeSubmission(submission, "unknown");
        assert.equal(handle.getSnapshot().input, "");
        assert.deepEqual(handle.getSnapshot().attachments, []);
        assert.deepEqual(handle.getSnapshot().recoveries, [
            {
                id: submission.id,
                target: a,
                input: "possibly sent",
                attachments: [file("uncertain")],
                uncertain: true,
            },
        ]);
        assert.deepEqual(revoked, []);
        handle.setInput("newer input");
        handle.recoverSubmission(submission.id);
        assert.equal(handle.getSnapshot().input, "possibly sent\nnewer input");
        assert.deepEqual(handle.getSnapshot().attachments, [file("uncertain")]);
        assert.deepEqual(handle.getSnapshot().recoveries, []);
        assert.deepEqual(revoked, []);
        handle.setAttachments([]);
        assert.deepEqual(revoked, ["blob:uncertain"]);
    });

    it("retains an uncertain recovery even when the composer was never cleared", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("possibly sent");
        handle.setAttachments([file("uncertain")]);
        const submission = handle.beginSubmission();
        manager.completeSubmission(submission, "unknown");
        assert.equal(handle.getSnapshot().input, "possibly sent");
        assert.deepEqual(handle.getSnapshot().attachments, [file("uncertain")]);
        assert.equal(handle.getSnapshot().recoveries.length, 1);
        assert.equal(handle.getSnapshot().recoveries[0]?.uncertain, true);
        manager.completeSubmission(submission, false);
        manager.completeSubmission(submission, true);
        assert.equal(handle.getSnapshot().recoveries.length, 1);
        assert.equal(handle.getSnapshot().input, "possibly sent");
    });

    it("keeps unknown results and their attachments on the migrated origin until release", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const origin = manager.bind(draft);
        origin.setInput("possibly sent");
        origin.setAttachments([file("uncertain")]);
        const submission = origin.beginSubmission();
        origin.setInput("");
        origin.setAttachments([]);
        manager.migrateDraft("/a", "same", "same");
        const other = manager.bind(b);
        other.setInput("keep B");
        manager.completeSubmission(submission, "unknown");
        assert.equal(other.getSnapshot().input, "keep B");
        assert.deepEqual(other.getSnapshot().recoveries, []);
        assert.equal(manager.bind(a).getSnapshot().input, "");
        assert.equal(manager.bind(a).getSnapshot().recoveries[0]?.uncertain, true);
        assert.deepEqual(manager.bind(a).getSnapshot().recoveries[0]?.target, a);
        assert.deepEqual(revoked, []);
        manager.release(draft);
        assert.deepEqual(revoked, ["blob:uncertain"]);
    });

    it("restores queued text into its explicit target without replacing newer input", () => {
        const manager = new ConversationDrafts();
        manager.bind(a).setInput("current");
        manager.bind(b).setInput("B");
        manager.restoreTexts(a, ["queued 1", "queued 2"]);
        assert.equal(manager.bind(a).getSnapshot().input, "queued 1\nqueued 2\ncurrent");
        assert.equal(manager.bind(b).getSnapshot().input, "B");
    });

    it("migrates in-flight submissions, late setters, and model selection", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(draft, { provider: "test", id: "initial" });
        handle.setInput("draft input");
        handle.setSelectedModel((prev) => ({ provider: prev?.provider ?? "", id: "chosen" }));
        const submission = handle.beginSubmission();
        manager.migrateDraft("/a", "same", "same");
        handle.setAttachments((prev) => [...prev, file("late")]);
        const session = manager.bind(a);
        assert.equal(session.getSnapshot().input, "draft input");
        assert.deepEqual(session.getSnapshot().selectedModel, { provider: "test", id: "chosen" });
        assert.deepEqual(session.getSnapshot().attachments, [file("late")]);
        manager.completeSubmission(submission, true);
        assert.equal(session.getSnapshot().input, "");
        assert.deepEqual(session.getSnapshot().attachments, [file("late")]);
        manager.restoreTexts(draft, ["returned"]);
        assert.equal(session.getSnapshot().input, "returned");
    });

    it("merges existing destination content during migration without losing either draft", () => {
        const manager = new ConversationDrafts();
        const source = manager.bind(draft);
        source.setInput("source");
        source.setAttachments([file("source")]);
        const destination = manager.bind(a);
        destination.setInput("destination");
        destination.setAttachments([file("destination")]);
        manager.migrateDraft("/a", "same", "same");
        manager.migrateDraft("/a", "same", "same");
        assert.equal(destination.getSnapshot().input, "source\ndestination");
        assert.deepEqual(destination.getSnapshot().attachments, [
            file("source"),
            file("destination"),
        ]);
        source.setInput((prev) => `${prev}!`);
        assert.equal(destination.getSnapshot().input, "source\ndestination!");
    });

    it("pins blob URLs through optimistic clear and recovery, revoking only at final removal", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const handle = manager.bind(a);
        handle.setInput("failed");
        handle.setAttachments([file("pinned"), file("asset", "asset://image")]);
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setAttachments([]);
        assert.deepEqual(revoked, []);
        handle.setInput("newer");
        manager.completeSubmission(submission, false);
        assert.deepEqual(revoked, []);
        handle.recoverSubmission(submission.id);
        handle.setAttachments([]);
        assert.deepEqual(revoked, ["blob:pinned"]);
        manager.release(a);
        assert.deepEqual(revoked, ["blob:pinned"]);
    });

    it("keeps a restored preview alive throughout automatic failure recovery", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const handle = manager.bind(a);
        handle.setInput("restore");
        handle.setAttachments([file("restore")]);
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setAttachments([]);
        manager.completeSubmission(submission, false);
        assert.deepEqual(revoked, []);
        handle.setAttachments([]);
        assert.deepEqual(revoked, ["blob:restore"]);
    });

    it("does not expose partially restored text without its attachments to subscribers", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("restore");
        handle.setAttachments([file("restore")]);
        const submission = handle.beginSubmission();
        handle.setInput("");
        handle.setAttachments([]);
        const observed: Array<{ input: string; files: number }> = [];
        manager.subscribe(() =>
            observed.push({
                input: handle.getSnapshot().input,
                files: handle.getSnapshot().attachments.length,
            }),
        );
        manager.completeSubmission(submission, false);
        assert.deepEqual(observed, [{ input: "restore", files: 1 }]);
    });

    it("holds a URL until the last overlapping send settles", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const handle = manager.bind(a);
        handle.setAttachments([file("shared")]);
        const first = handle.beginSubmission();
        const second = handle.beginSubmission();
        manager.completeSubmission(second, true);
        assert.deepEqual(handle.getSnapshot().attachments, []);
        assert.deepEqual(revoked, []);
        manager.completeSubmission(first, false);
        assert.deepEqual(handle.getSnapshot().attachments, [file("shared")]);
        assert.deepEqual(revoked, []);
        manager.release(a);
        assert.deepEqual(revoked, ["blob:shared"]);
    });

    it("keeps two out-of-order failures as independent recoveries", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("first");
        const first = handle.beginSubmission();
        handle.setInput("");
        handle.setInput("second");
        const second = handle.beginSubmission();
        handle.setInput("");
        handle.setInput("newer");
        manager.completeSubmission(second, false);
        manager.completeSubmission(first, false);
        assert.equal(handle.getSnapshot().input, "newer");
        assert.deepEqual(
            handle.getSnapshot().recoveries.map((item) => item.input),
            ["second", "first"],
        );
    });

    it("keeps shared URLs alive until no draft or pending submission owns them", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const first = manager.bind(a);
        first.setAttachments([file("shared")]);
        manager.bind(b).setAttachments([file("shared")]);
        manager.release(a);
        assert.deepEqual(revoked, []);
        manager.release(b);
        assert.deepEqual(revoked, ["blob:shared"]);
    });

    it("makes completion idempotent and ignores completion from a different manager", () => {
        const manager = new ConversationDrafts();
        const handle = manager.bind(a);
        handle.setInput("one");
        const submission = handle.beginSubmission();
        new ConversationDrafts().completeSubmission(submission, true);
        assert.equal(handle.getSnapshot().input, "one");
        manager.completeSubmission(submission, true);
        handle.setInput("two");
        manager.completeSubmission(submission, true);
        assert.equal(handle.getSnapshot().input, "two");
    });

    it("releases migrated aliases and ignores late callbacks without reviving released drafts", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        const handle = manager.bind(draft);
        handle.setAttachments([file("existing")]);
        const submission = handle.beginSubmission();
        manager.migrateDraft("/a", "same", "same");
        manager.release(draft);
        handle.setInput("late text");
        handle.setAttachments((prev) => [...prev, file("late")]);
        manager.completeSubmission(submission, false);
        assert.equal(handle.getSnapshot().input, "");
        assert.deepEqual(handle.getSnapshot().attachments, []);
        assert.deepEqual(revoked, ["blob:existing", "blob:late"]);
        assert.equal(manager.bind(a).getSnapshot().input, "");
    });

    it("disposes every target, submission and recovery exactly once", () => {
        const revoked: string[] = [];
        const manager = new ConversationDrafts((url) => revoked.push(url));
        manager.bind(a).setAttachments([file("a")]);
        const handle = manager.bind(b);
        handle.setAttachments([file("b")]);
        handle.beginSubmission();
        handle.setAttachments([]);
        manager.dispose();
        manager.dispose();
        assert.deepEqual(revoked.sort(), ["blob:a", "blob:b"]);
    });

    it("keeps released callbacks separate from a newly opened draft at the same target", () => {
        const manager = new ConversationDrafts();
        const old = manager.bind(a);
        old.setInput("old");
        const submission = old.beginSubmission();
        manager.release(a);
        const reopened = manager.bind(a);
        reopened.setInput("new lifetime");
        old.setInput("late");
        manager.completeSubmission(submission, true);
        assert.equal(reopened.getSnapshot().input, "new lifetime");
    });

    it("migrates an empty draft before its first attachment callback arrives", () => {
        const manager = new ConversationDrafts();
        manager.migrateDraft("/a", "same", "same");
        manager.bind(draft).setAttachments([file("late")]);
        assert.deepEqual(manager.bind(a).getSnapshot().attachments, [file("late")]);
    });
});
