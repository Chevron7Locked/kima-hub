import { ReactNode } from "react";

interface SettingsSectionProps {
    id: string;
    title: string;
    description?: string;
    children: ReactNode;
    showSeparator?: boolean;
}

export function SettingsSection({
    id,
    title,
    description,
    children,
    showSeparator = true
}: SettingsSectionProps) {
    return (
        <section id={id} className="scroll-mt-24">
            <div className="mb-4">
                <div className="flex items-center gap-3 mb-1">
                    <span className="w-1 h-6 bg-gradient-to-b from-brand to-[#f97316] rounded-full shrink-0" />
                    <h2 className="text-lg font-bold tracking-tight text-white">{title}</h2>
                    <span className="flex-1 border-t border-white/10" />
                </div>
                {description && (
                    <p className="text-xs font-mono text-white/40 mt-1 ml-[calc(0.25rem+0.75rem+4px)] uppercase tracking-wider">{description}</p>
                )}
            </div>

            <div className="space-y-1">
                {children}
            </div>

            {showSeparator && (
                <div className="border-t border-white/5 mt-8 mb-8" />
            )}
        </section>
    );
}
