/**
 * AddAgentMenu — the agents pane's "+" button. Opens a menu of the two agent
 * kinds; picking one opens that kind's form. The kind is chosen here rather
 * than inside the form because the two share almost no settings.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { AgentRuntime } from "@taco-ai/protocol";
import { Plus } from "lucide-react";
import { useT } from "../../i18n/useI18n.ts";
import { IconButton } from "../ui/IconButton.tsx";

const KINDS: ReadonlyArray<{ runtime: AgentRuntime; labelKey: string; hintKey: string }> = [
    { runtime: "standard", labelKey: "agents.addStandard", hintKey: "agents.addStandardHint" },
    { runtime: "claude-code", labelKey: "agents.addCc", hintKey: "agents.addCcHint" },
];

export function AddAgentMenu({ onPick }: { onPick: (runtime: AgentRuntime) => void }) {
    const { t } = useT();
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <IconButton title={t("agents.new")} aria-label={t("agents.new")}>
                    <Plus size={14} aria-hidden="true" />
                </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                {/* The pane header sits at the top edge, so the menu opens
                    downward; Radix flips it if that ever runs out of room. */}
                <DropdownMenu.Content
                    className="topbar-quick-menu agent-add-menu"
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    collisionPadding={8}
                >
                    {KINDS.map((k) => (
                        <DropdownMenu.Item
                            key={k.runtime}
                            className="agent-add-item"
                            onSelect={() => onPick(k.runtime)}
                        >
                            <span className="agent-add-item-label">{t(k.labelKey)}</span>
                            <span className="agent-add-item-hint">{t(k.hintKey)}</span>
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
