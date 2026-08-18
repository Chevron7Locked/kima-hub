import { ReactNode } from "react";

interface SettingsRowProps {
    label: string;
    description?: ReactNode;
    children: ReactNode;
    htmlFor?: string;
}

export function SettingsRow({ label, description, children, htmlFor }: SettingsRowProps) {
    return (
        // Mobile: stack the label above the control so wide inputs (Server URL,
        // paths, API keys) get the full row width instead of squeezing the
        // description into a cramped column. sm+ restores the two-column row.
        <div className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:min-h-[56px]">
            <div className="sm:flex-1">
                <label
                    htmlFor={htmlFor}
                    className="text-sm font-medium text-white cursor-pointer"
                >
                    {label}
                </label>
                {description && (
                    <p className="text-xs tabular-nums text-[var(--text-muted)] mt-0.5">{description}</p>
                )}
            </div>
            <div className="w-full sm:w-auto sm:shrink-0">
                {children}
            </div>
        </div>
    );
}
