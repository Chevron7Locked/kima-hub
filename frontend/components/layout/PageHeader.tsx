import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PageHeaderProps {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
    className?: string;
}

export function PageHeader({ title, description, actions, children, className }: PageHeaderProps) {
    return (
        <header className={cn("page-shell pt-6 pb-5", className)}>
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="t-page-title">{title}</h1>
                    {description && <p className="mt-2 text-sm text-[var(--text-muted)]">{description}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
            </div>
            {children}
        </header>
    );
}
