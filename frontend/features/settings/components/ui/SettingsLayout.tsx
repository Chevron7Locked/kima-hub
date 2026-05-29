"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SettingsSidebar, SidebarItem } from "./SettingsSidebar";
import { Settings } from "lucide-react";

interface SettingsLayoutProps {
    children: ReactNode;
    sidebarItems: SidebarItem[];
    isAdmin: boolean;
}

export function SettingsLayout({ children, sidebarItems, isAdmin }: SettingsLayoutProps) {
    const [activeSection, setActiveSection] = useState(sidebarItems[0]?.id || "");
    const mainContentRef = useRef<HTMLDivElement>(null);

    // Handle sidebar click - scroll to section
    const handleSectionClick = useCallback((id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "start" });
            setActiveSection(id);
        }
    }, []);

    // Track active section based on scroll position
    useEffect(() => {
        const visibleItems = sidebarItems.filter(item => !item.adminOnly || isAdmin);

        const findScrollableParent = (el: HTMLElement | null): HTMLElement | null => {
            while (el) {
                const style = window.getComputedStyle(el);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        };

        const scrollContainer = mainContentRef.current
            ? findScrollableParent(mainContentRef.current)
            : null;

        if (!scrollContainer) return;

        const handleScroll = () => {
            const containerRect = scrollContainer.getBoundingClientRect();
            const offset = 150;

            let currentSection = visibleItems[0]?.id || "";

            for (const item of visibleItems) {
                const element = document.getElementById(item.id);
                if (element) {
                    const rect = element.getBoundingClientRect();
                    if (rect.top <= containerRect.top + offset) {
                        currentSection = item.id;
                    }
                }
            }

            setActiveSection(prev => {
                if (prev !== currentSection) {
                    return currentSection;
                }
                return prev;
            });
        };

        let ticking = false;
        const scrollHandler = () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    handleScroll();
                    ticking = false;
                });
                ticking = true;
            }
        };

        scrollContainer.addEventListener("scroll", scrollHandler, { passive: true });
        handleScroll();

        return () => scrollContainer.removeEventListener("scroll", scrollHandler);
    }, [sidebarItems, isAdmin]);

    return (
        <div className="min-h-screen bg-[var(--bg-primary)] relative">
            <div className="relative max-w-[1800px] mx-auto px-4 md:px-8 pt-8 pb-8">
                {/* Editorial Header */}
                <div className="mb-10">
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-brand rounded-full" />
                        <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                            System Configuration
                        </span>
                    </div>

                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                            <Settings className="w-6 h-6 text-brand" />
                        </div>
                        <div>
                            <h1 className="text-4xl md:text-5xl font-black tracking-tighter text-white leading-none">
                                SETTINGS
                            </h1>
                        </div>
                    </div>
                </div>

                {/* Layout */}
                <div className="flex gap-12">
                    <SettingsSidebar
                        items={sidebarItems}
                        activeSection={activeSection}
                        onSectionClick={handleSectionClick}
                        isAdmin={isAdmin}
                    />

                    <main ref={mainContentRef} className="flex-1 min-w-0">
                        {children}
                    </main>
                </div>
            </div>
        </div>
    );
}
