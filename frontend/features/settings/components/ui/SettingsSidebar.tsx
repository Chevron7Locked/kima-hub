"use client";

export interface SidebarItem {
    id: string;
    label: string;
    adminOnly?: boolean;
}

interface SettingsSidebarProps {
    items: SidebarItem[];
    activeSection: string;
    onSectionClick: (id: string) => void;
    isAdmin: boolean;
}

export function SettingsSidebar({ items, activeSection, onSectionClick, isAdmin }: SettingsSidebarProps) {
    const filteredItems = items.filter(item => !item.adminOnly || isAdmin);

    const regularItems = filteredItems.filter(item => !item.adminOnly);
    const adminItems = filteredItems.filter(item => item.adminOnly);

    return (
        <nav className="w-48 shrink-0 sticky top-8 self-start hidden md:block">
            <div className="space-y-0.5">
                {regularItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => onSectionClick(item.id)}
                        className={`
                            w-full text-left px-3 py-2 rounded-lg text-sm font-mono transition-all
                            ${activeSection === item.id
                                ? 'text-brand bg-brand/10 border border-brand/20'
                                : 'text-white/40 hover:text-white/70 border border-transparent'
                            }
                        `}
                    >
                        {item.label}
                    </button>
                ))}

                {adminItems.length > 0 && (
                    <>
                        <div className="pt-4 pb-2 px-3">
                            <span className="text-[10px] font-mono text-white/30 uppercase tracking-wider">
                                Admin
                            </span>
                        </div>
                        {adminItems.map((item) => (
                            <button
                                key={item.id}
                                onClick={() => onSectionClick(item.id)}
                                className={`
                                    w-full text-left px-3 py-2 rounded-lg text-sm font-mono transition-all
                                    ${activeSection === item.id
                                        ? 'text-brand bg-brand/10 border border-brand/20'
                                        : 'text-white/40 hover:text-white/70 border border-transparent'
                                    }
                                `}
                            >
                                {item.label}
                            </button>
                        ))}
                    </>
                )}
            </div>
        </nav>
    );
}
