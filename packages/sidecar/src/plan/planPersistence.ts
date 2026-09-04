import { join } from "node:path";

export function getPlansDir(cwd: string): string {
    return join(cwd, ".taco", "plans");
}

export function getPlanPath(plansDir: string, slug: string): string {
    return join(plansDir, `${slug}.md`);
}
