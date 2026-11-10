import type { ReactNode } from "react";

export interface ContentHeaderProps {
    title: string;
    description?: string;
    actions?: ReactNode;
}

/** Heading for a content page, separate from compact list-pane controls. */
export function ContentHeader({ title, description, actions }: ContentHeaderProps) {
    return (
        <header className="pane-content-header">
            <div className="pane-content-heading">
                <h1>{title}</h1>
                {description && <p>{description}</p>}
            </div>
            {actions && <div className="pane-content-actions">{actions}</div>}
        </header>
    );
}
