/**
 * Minimal terminal helpers — raw mode input and output formatting.
 */

export class Terminal {
    private prompt = "";

    setPrompt(p: string) {
        this.prompt = p;
        process.stdout.write(p);
    }

    print(msg: string) {
        // Move cursor to line start, clear to end of line, print
        process.stdout.write(`\r\x1b[K${msg}\r\n${this.prompt}`);
    }
}
