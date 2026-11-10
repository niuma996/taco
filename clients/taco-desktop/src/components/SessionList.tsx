/** Shared session rows for filesystem workspaces and flat IM conversations. */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Link2, Pencil, Trash } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { useNow } from "../hooks/useNow";
import { useT, useUiLanguage } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime";
import { IconButton } from "./ui/IconButton";

export interface SessionListItem {
    /** Stable row key; IM rows use their full conversation cwd. */
    key: string;
    id: string;
    label: string;
    updatedAt: string | number;
    running: boolean;
    waiting?: boolean;
    incomplete?: boolean;
    error?: boolean;
    unread?: boolean;
    active: boolean;
    title?: string;
    /** Short badge shown next to the title (IM rows carry their channel). */
    tag?: string;
}

function statusFor(item: SessionListItem): "idle" | "running" | "waiting" | "error" | "incomplete" {
    if (item.waiting) return "waiting";
    if (item.error) return "error";
    if (item.incomplete) return "incomplete";
    return item.running ? "running" : "idle";
}

export interface SessionListProps {
    items: readonly SessionListItem[];
    className: string;
    onOpen: (item: SessionListItem) => void;
    onRename: (item: SessionListItem) => void;
    onDelete: (item: SessionListItem) => void;
    onManageAssociations?: (item: SessionListItem) => void;
    /** Search empty states and pagination remain owned by the caller. */
    children?: ReactNode;
}

export function SessionList(props: SessionListProps) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const statusId = useId();
    const listRef = useRef<HTMLUListElement>(null);

    const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        // Let the row's menu button keep its own Home/End/arrow behavior.
        if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-session-row]"))
            return;
        const rows = Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-row]") ?? [],
        );
        if (rows.length === 0) return;
        event.preventDefault();
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : Math.min(
                        rows.length - 1,
                        Math.max(
                            0,
                            (current < 0 ? -1 : current) + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                    );
        rows[index]?.focus();
    };

    return (
        <ul className={props.className} ref={listRef} onKeyDown={handleListKeyDown}>
            {props.items.map((item, index) => {
                const status = statusFor(item);
                return (
                    <li className={`session-item${item.active ? " active" : ""}`} key={item.key}>
                        <button
                            type="button"
                            className="session-item-main"
                            data-session-row={item.id}
                            aria-label={item.label}
                            aria-describedby={`${statusId}-${index}-status${item.unread ? ` ${statusId}-${index}-unread` : ""}`}
                            onClick={() => props.onOpen(item)}
                        >
                            <span className="session-meta">
                                <span className="session-main">
                                    <span
                                        className={`session-status-dot ${status}`}
                                        id={`${statusId}-${index}-status`}
                                        role="img"
                                        aria-label={t(`session.status.${status}`)}
                                        title={t(`session.status.${status}`)}
                                    />
                                    <span className="session-id" title={item.title ?? item.label}>
                                        {item.label}
                                    </span>
                                    {item.unread && (
                                        <span
                                            className="session-unread-dot"
                                            id={`${statusId}-${index}-unread`}
                                            role="img"
                                            aria-label={t("session.status.unread")}
                                            title={t("session.status.unread")}
                                        />
                                    )}
                                </span>
                                <span className="session-secondary">
                                    <span className="session-time">
                                        {formatRelativeTime(item.updatedAt, lng, nowMs)}
                                    </span>
                                    {item.tag && (
                                        <span className="session-tag" title={item.tag}>
                                            {item.tag}
                                        </span>
                                    )}
                                </span>
                            </span>
                        </button>
                        <div className="session-actions">
                            <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                    <IconButton
                                        className="session-action"
                                        title={t("session.moreActions")}
                                        aria-label={t("session.moreActions")}
                                    >
                                        <Ellipsis size={15} aria-hidden="true" />
                                    </IconButton>
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                    <DropdownMenu.Content
                                        className="ui-menu session-actions-menu"
                                        side="bottom"
                                        align="end"
                                        sideOffset={4}
                                        collisionPadding={8}
                                    >
                                        <DropdownMenu.Item
                                            className="ui-menu-item"
                                            onSelect={() => props.onRename(item)}
                                        >
                                            <Pencil size={14} aria-hidden="true" />
                                            <span className="ui-menu-label">
                                                {t("session.rename")}
                                            </span>
                                        </DropdownMenu.Item>
                                        {props.onManageAssociations && (
                                            <DropdownMenu.Item
                                                className="ui-menu-item"
                                                onSelect={() => props.onManageAssociations?.(item)}
                                            >
                                                <Link2 size={14} aria-hidden="true" />
                                                <span className="ui-menu-label">
                                                    {t("activity.manageAssociations")}
                                                </span>
                                            </DropdownMenu.Item>
                                        )}
                                        <DropdownMenu.Item
                                            className="ui-menu-item session-actions-menu-danger"
                                            onSelect={() => props.onDelete(item)}
                                        >
                                            <Trash size={14} aria-hidden="true" />
                                            <span className="ui-menu-label">
                                                {t("session.deleteSession")}
                                            </span>
                                        </DropdownMenu.Item>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                        </div>
                    </li>
                );
            })}
            {props.children}
        </ul>
    );
}
