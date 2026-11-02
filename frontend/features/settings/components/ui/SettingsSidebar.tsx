"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { SETTINGS_PAGES, type SettingsPage } from "../../pages";

export interface SidebarItem {
    id: string;
    label: string;
}

interface SettingsSidebarProps {
    page: SettingsPage;
    activeSection: string;
    onSectionClick: (id: string) => void;
    isAdmin: boolean;
}

/** The settings pages, with the open one's sections listed under it so a long page can be jumped through. */
export function SettingsSidebar({ page, activeSection, onSectionClick, isAdmin }: SettingsSidebarProps) {
    return (
        <nav aria-label="settings" className="w-48 shrink-0 sticky top-8 self-start hidden md:block">
            <ul className="space-y-0.5">
                {SETTINGS_PAGES.filter((p) => !p.adminOnly || isAdmin).map((p) => {
                    const current = p.slug === page.slug;
                    return (
                        <li key={p.slug}>
                            <Link
                                href={p.href}
                                aria-current={current ? "page" : undefined}
                                className={cn(
                                    "block rounded-lg px-3 py-2 text-sm transition-colors",
                                    current
                                        ? "font-medium text-[var(--text-primary)]"
                                        : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                                )}
                            >
                                {p.label}
                            </Link>
                            {current && page.sections.length > 1 && (
                                <ul className="mb-2 ml-3 border-l border-white/10">
                                    {page.sections.map((item) => (
                                        <li key={item.id}>
                                            <button
                                                type="button"
                                                onClick={() => onSectionClick(item.id)}
                                                aria-current={activeSection === item.id ? "true" : undefined}
                                                className={cn(
                                                    "-ml-px block w-full border-l py-1.5 pl-3 text-left text-xs transition-colors",
                                                    activeSection === item.id
                                                        ? "border-brand text-brand"
                                                        : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                                                )}
                                            >
                                                {item.label}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
