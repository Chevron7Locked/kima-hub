import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/Button";

interface PageMessageProps {
    icon?: ReactNode;
    title: string;
    description?: ReactNode;
    action?: { label: string; href: string } | { label: string; onClick: () => void };
}

/* A whole page standing in for content that is missing or failed to load. */
export function PageMessage({ icon, title, description, action }: PageMessageProps) {
    return (
        <div className="page-shell flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
            {icon && <div className="mb-4 text-[var(--text-muted)] [&_svg]:h-10 [&_svg]:w-10">{icon}</div>}
            <h1 className="t-page-title">{title}</h1>
            {description && <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">{description}</p>}
            {action &&
                ("href" in action ? (
                    <Link href={action.href} className={buttonClass("secondary", "md", "mt-6")}>
                        {action.label}
                    </Link>
                ) : (
                    <button type="button" onClick={action.onClick} className={buttonClass("secondary", "md", "mt-6")}>
                        {action.label}
                    </button>
                ))}
        </div>
    );
}
