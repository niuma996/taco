import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser, type Tree } from "web-tree-sitter";

export type ShellLanguage = "bash" | "powershell" | "unknown";
export type ShellNodeKind = "command" | "cd" | "unknown";
export interface ParsedShellNode {
    text: string;
    kind: ShellNodeKind;
    argv: string[];
    args: string[];
    start: number;
    end: number;
    operator?: string;
    cwd?: string;
    dynamic?: boolean;
    redirects?: boolean;
}
export interface ParsedShellCommand {
    language: ShellLanguage;
    nodes: ParsedShellNode[];
    operators: string[];
    complete: boolean;
    reason?: string;
}

const MAX_LENGTH = 131_072;
const MAX_NODES = 2_048;
const MAX_DEPTH = 128;
const parsers = new Map<ShellLanguage, Parser>();
let initializationError: string | undefined;

// Source and bundled execution both use adjacent grammar assets. Initialization
// failure disables automatic approval but never prevents the sidecar starting.
try {
    const runtimeUrl = new URL("./grammars/tree-sitter.wasm", import.meta.url);
    const runtimePath = existsSync(runtimeUrl)
        ? fileURLToPath(runtimeUrl)
        : createRequire(import.meta.url).resolve("web-tree-sitter/tree-sitter.wasm");
    await Parser.init({ wasmBinary: readFileSync(runtimePath) });
    for (const language of ["bash", "powershell"] as const) {
        const parser = new Parser();
        parser.setLanguage(
            await Language.load(
                readFileSync(new URL(`./grammars/tree-sitter-${language}.wasm`, import.meta.url)),
            ),
        );
        parsers.set(language, parser);
    }
} catch (error) {
    initializationError = `Shell parser unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

const containers: Record<"bash" | "powershell", Set<string>> = {
    bash: new Set(["program", "list", "pipeline", "redirected_statement"]),
    powershell: new Set([
        "program",
        "statement_list",
        "pipeline",
        "pipeline_chain",
        "pipeline_chain_tail",
        "empty_statement",
    ]),
};
const bashLiteralTypes = new Set([
    "command_name",
    "word",
    "raw_string",
    "string",
    "string_content",
    "concatenation",
    "number",
]);
const powershellLiteralTypes = new Set([
    "command_name",
    "generic_token",
    "command_parameter",
    "array_literal_expression",
    "unary_expression",
    "string_literal",
    "expandable_string_literal",
    "verbatim_string_characters",
    "integer_literal",
    "decimal_integer_literal",
]);

/** Decode one AST-delimited word without executing any expansion. */
function literal(node: Node, language: "bash" | "powershell"): { value: string; dynamic: boolean } {
    const types = language === "bash" ? bashLiteralTypes : powershellLiteralTypes;
    let dynamic = false;
    const check = (part: Node, depth: number): void => {
        if (depth > MAX_DEPTH || !types.has(part.type)) {
            dynamic = true;
            return;
        }
        for (const child of part.namedChildren) if (child) check(child, depth + 1);
    };
    check(node, 0);
    let value = "";
    let quote = "";
    const text = node.text;
    for (let index = 0; index < text.length; index++) {
        const ch = text[index];
        if (quote === "'") {
            if (ch === "'") {
                if (language === "powershell" && text[index + 1] === "'") {
                    value += "'";
                    index++;
                } else quote = "";
            } else value += ch;
            continue;
        }
        if (ch === "'" && !quote) {
            quote = "'";
            continue;
        }
        if (ch === '"') {
            quote = quote ? "" : '"';
            continue;
        }
        const escapeChar = language === "bash" ? "\\" : "`";
        if (ch === escapeChar) {
            const next = text[index + 1];
            if (next === undefined) {
                dynamic = true;
                break;
            }
            if (language === "bash" && quote && !["$", "`", '"', "\\", "\n"].includes(next))
                value += ch;
            else {
                if (next !== "\n") {
                    if (language === "powershell") {
                        const special: Record<string, string> = {
                            n: "\n",
                            r: "\r",
                            t: "\t",
                            "0": "\0",
                            a: "\x07",
                            b: "\b",
                            f: "\f",
                            v: "\v",
                            e: "\x1b",
                        };
                        value += special[next] ?? next;
                    } else value += next;
                }
                index++;
                continue;
            }
        }
        if (ch === "$" || (language === "bash" && ch === "`")) dynamic = true;
        // Tilde is a valid literal in Git revisions (HEAD~1) and paths after
        // quoting has been decoded; only shell expansion metacharacters make a
        // token dynamic here.
        if (
            !quote &&
            ((language === "bash" && /[*?[\]{}]/.test(ch)) ||
                (language === "powershell" && /[(){}@,]/.test(ch)))
        )
            dynamic = true;
        value += ch;
    }
    return { value, dynamic: dynamic || !!quote };
}

export function parseShellCommand(command: string, language?: ShellLanguage): ParsedShellCommand {
    const lang = language ?? (process.platform === "win32" ? "powershell" : "bash");
    const result: ParsedShellCommand = { language: lang, nodes: [], operators: [], complete: true };
    const incomplete = (reason: string): void => {
        result.complete = false;
        result.reason ??= reason;
    };
    if (command.length > MAX_LENGTH) {
        incomplete("Shell command exceeds parser length limit");
        return result;
    }
    const parser = parsers.get(lang);
    if (!parser || lang === "unknown") {
        incomplete(initializationError ?? "Unsupported shell language");
        return result;
    }
    let tree: Tree | null = null;
    let visits = 0;
    try {
        const deadline = performance.now() + 100;
        tree = parser.parse(command, null, {
            progressCallback: () => performance.now() > deadline,
        });
        if (!tree) {
            incomplete("Shell parsing exceeded its time limit");
            return result;
        }
        if (tree.rootNode.hasError) incomplete("Shell syntax is incomplete or invalid");
        const nestedCommands = (node: Node, depth: number): void => {
            for (const child of node.namedChildren) {
                if (!child) continue;
                if (child.type === "command") visit(child, depth + 1, false);
                else if (depth < MAX_DEPTH && ++visits <= MAX_NODES)
                    nestedCommands(child, depth + 1);
                else incomplete("Shell AST exceeds analysis limits");
            }
        };
        const visit = (node: Node, depth: number, redirected: boolean): void => {
            if (++visits > MAX_NODES || depth > MAX_DEPTH) {
                incomplete("Shell AST exceeds analysis limits");
                return;
            }
            if (node.type === "comment") return;
            if (node.type === "command") {
                const name =
                    node.childForFieldName("name") ?? node.childForFieldName("command_name");
                let dynamic = !name;
                const argv: string[] = [];
                let redirects = redirected;
                const add = (part: Node): void => {
                    const decoded = literal(part, lang);
                    argv.push(decoded.value);
                    dynamic ||= decoded.dynamic;
                };
                if (name) add(name);
                for (const child of node.namedChildren) {
                    if (!child) continue;
                    if (name && child.id === name.id) continue;
                    if (lang === "powershell" && child.type === "command_elements") {
                        for (const argument of child.namedChildren) {
                            if (!argument) continue;
                            if (argument.type === "command_argument_sep") continue;
                            if (argument.type === "redirection") {
                                redirects = true;
                                continue;
                            }
                            add(argument);
                        }
                    } else if (lang === "bash" && child.type !== "variable_assignment") add(child);
                    else dynamic = true;
                }
                if (argv[0]?.includes("/") || (lang === "powershell" && argv[0]?.includes("\\")))
                    dynamic = true;
                const first = argv[0]?.toLowerCase();
                const cd = first === "cd" || (lang === "powershell" && first === "set-location");
                let cwd: string | undefined;
                if (cd) {
                    const args = argv.slice(1);
                    if (lang === "powershell" && /^-(literalpath|path)$/i.test(args[0] ?? ""))
                        args.shift();
                    if (lang === "bash" && args[0] === "--") args.shift();
                    if (args.length === 1 && args[0] !== "-" && !args[0].startsWith("-"))
                        cwd = args[0];
                    else dynamic = true;
                }
                result.nodes.push({
                    text: node.text,
                    kind: cd ? "cd" : dynamic ? "unknown" : "command",
                    argv,
                    args: argv.slice(1),
                    start: node.startIndex,
                    end: node.endIndex,
                    dynamic,
                    ...(cwd !== undefined ? { cwd } : {}),
                    ...(redirects ? { redirects: true } : {}),
                });
                if (dynamic) incomplete("Shell command contains dynamic or unsupported execution");
                nestedCommands(node, depth);
                return;
            }
            if (node.type === "file_redirect" || node.type === "heredoc_redirect") {
                if (node.type === "heredoc_redirect") incomplete("Here documents require approval");
                nestedCommands(node, depth);
                return;
            }
            if (!containers[lang].has(node.type))
                incomplete(`Unsupported shell construct: ${node.type}`);
            for (const child of node.children) {
                if (!child) continue;
                if (child.isNamed)
                    visit(child, depth + 1, redirected || node.type === "redirected_statement");
                else if (!["&&", "||", ";", "|", "\n", "\r\n"].includes(child.text))
                    incomplete(`Unsupported shell operator: ${child.text}`);
            }
        };
        visit(tree.rootNode, 0, false);
        let previous: ParsedShellNode | undefined;
        for (const node of result.nodes) {
            if (previous && node.start >= previous.end) {
                const gap = command.slice(previous.end, node.start).replace(/#[^\r\n]*/g, "");
                const operator = gap.match(/&&|\|\||;|\||\n/)?.[0];
                if (operator) {
                    node.operator = operator;
                    result.operators.push(operator);
                }
            }
            previous = node;
        }
        if (!result.nodes.length && command.trim())
            incomplete("No statically analyzable shell command");
        return result;
    } catch (error) {
        incomplete(
            `Shell parser failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return result;
    } finally {
        tree?.delete();
    }
}
