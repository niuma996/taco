/** Offline extraction precision/recall examples; expected outcomes require semantic judgment. */
export const admissionCases = [
    { user: "什么是 Redis？", expected: "skip", reason: "knowledge question" },
    { user: "今天这段改成英文。", expected: "skip", reason: "current-task formatting" },
    { user: "我可能会试试 Rust。", expected: "skip", reason: "tentative interest" },
    { user: "不错，可以。", expected: "skip", reason: "one-off approval" },
    { user: "编译通过了，继续下一步。", expected: "skip", reason: "task progress" },
    { user: "看看这个 https://example.com", expected: "skip", reason: "one-off link" },
    { user: "假如以后迁移到 PostgreSQL，会有什么风险？", expected: "skip", reason: "hypothetical" },
    {
        user: "以后用中文回复。",
        expected: "durable_preference",
        reason: "explicit lasting language",
    },
    {
        user: "记住：我是这个项目的财务审批负责人。",
        expected: "explicit_request",
        reason: "explicit memory request",
    },
    {
        user: "以后不要在没跑测试的情况下说验证通过。",
        expected: "correction",
        reason: "general behavior correction",
    },
    {
        user: "我们决定今后所有计费变更都必须经过财务审核。",
        expected: "confirmed_decision",
        reason: "adopted continuing project constraint",
    },
    {
        user: "项目缺陷统一在 https://issues.example.com 跟踪，以后排查先查这里。",
        expected: "recurring_reference",
        reason: "recurring external source",
    },
] as const;
