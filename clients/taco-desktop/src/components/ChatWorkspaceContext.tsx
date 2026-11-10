/** Current chat's workspace/channel identity in the main session header. */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { parseImCwd } from "@taco-ai/protocol";
import { Check, ChevronDown, Folder, MessagesCircle } from "lucide-react";
import { useT } from "../i18n/useI18n";
import type { WorkspaceState } from "../lib/chat/workspaceReducer";
import { lastSegment } from "../lib/workspaceStorage";

export interface ChatWorkspaceContextProps {
    cwd: string;
    workspaces: Record<string, WorkspaceState>;
    /** Only a filesystem new-chat draft offers workspace switching. */
    switchable: boolean;
    onSelect: (cwd: string) => void;
}

export function ChatWorkspaceContext(props: ChatWorkspaceContextProps) {
    const { t } = useT();
    if (!props.cwd) return null;
    const im = parseImCwd(props.cwd);
    const label = im ? `${im.channelId} / ${im.chatId}` : lastSegment(props.cwd);
    const options = Object.values(props.workspaces).filter(
        (workspace) => !workspace.cwd.startsWith("im://"),
    );
    const canSwitch = !im && props.switchable && options.length > 1;
    const content = (
        <>
            {im ? (
                <MessagesCircle size={13} aria-hidden="true" />
            ) : (
                <Folder size={13} aria-hidden="true" />
            )}
            <span className="session-info-context-label">{label}</span>
            {canSwitch && <ChevronDown size={12} aria-hidden="true" />}
        </>
    );

    if (!canSwitch) {
        return (
            <span className="session-info-context" title={props.cwd}>
                {content}
            </span>
        );
    }
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="session-info-context switchable"
                    title={props.cwd}
                    aria-label={t("session.switchWorkspace")}
                >
                    {content}
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="ui-menu"
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                >
                    <DropdownMenu.RadioGroup value={props.cwd} onValueChange={props.onSelect}>
                        {options.map((workspace) => (
                            <DropdownMenu.RadioItem
                                className="ui-menu-item"
                                value={workspace.cwd}
                                key={workspace.cwd}
                            >
                                <Folder size={14} aria-hidden="true" />
                                <span className="ui-menu-label" title={workspace.cwd}>
                                    {lastSegment(workspace.cwd)}
                                </span>
                                {workspace.cwd === props.cwd && (
                                    <Check size={14} aria-hidden="true" />
                                )}
                            </DropdownMenu.RadioItem>
                        ))}
                    </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
