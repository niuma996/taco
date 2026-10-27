/**
 * Client-side rendering of a server error.
 *
 * The sidecar answers a schema failure with `invalid_params` and an
 * `issues` list naming the offending fields. Every desktop surface shows
 * `error.message`, so the details are folded into the message once, here —
 * instead of teaching each surface to read `error.data`.
 */
import { ErrorCodes, type RpcValidationIssue, readValidationIssues } from "@taco-ai/protocol";

/** One issue as `/field/path: reason`. */
export function formatValidationIssue(issue: RpcValidationIssue): string {
    const path = issue.path.length > 0 ? `/${issue.path.join("/")}` : "(root)";
    return `${path}: ${issue.message}`;
}

/** All issues as one line, `; ` separated. */
export function formatValidationIssues(issues: readonly RpcValidationIssue[]): string {
    return issues.map(formatValidationIssue).join("; ");
}

/**
 * The message a client should show for a server error.
 *
 * Only schema failures are expanded; every other code keeps the server's own
 * wording, which is already specific (`session not found`, `not ready`).
 */
export function describeRpcError(code: string, message: string, data: unknown): string {
    if (code !== ErrorCodes.InvalidParams) return message;
    const issues = readValidationIssues(data);
    if (!issues) return message;
    return `${message}: ${formatValidationIssues(issues)}`;
}
