"use client";

import { ReactNode, memo } from "react";
import { Button } from "./Button";

export interface EmptyStateProps {
    icon: ReactNode;
    title: string;
    description: string;
    children?: ReactNode;
    action?: {
        label: string;
        onClick: () => void;
        variant?: "primary" | "secondary" | "ghost";
    };
}

const EmptyState = memo(function EmptyState({
    icon,
    title,
    description,
    children,
    action,
}: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center py-12 md:py-16 text-center px-4">
            <div className="mb-4 text-[var(--text-muted)]">{icon}</div>
            <h3 className="text-lg md:text-xl font-medium text-white mb-2">
                {title}
            </h3>
            <p className="text-sm md:text-base text-[var(--text-muted)] mb-6 max-w-md">
                {description}
            </p>
            {children}
            {action && (
                <Button
                    variant={action.variant || "primary"}
                    onClick={action.onClick}
                >
                    {action.label}
                </Button>
            )}
        </div>
    );
});

export { EmptyState };
