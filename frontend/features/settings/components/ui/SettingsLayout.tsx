"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SettingsSidebar, SidebarItem } from "./SettingsSidebar";
import { PageHeader } from "@/components/layout/PageHeader";

const SETTLE_MS = 150;
// How far the reader has to move the page before the menu goes back to marking by position.
const MOVED_PX = 24;

interface SettingsLayoutProps {
    children: ReactNode;
    sidebarItems: SidebarItem[];
    isAdmin: boolean;
}

export function SettingsLayout({ children, sidebarItems, isAdmin }: SettingsLayoutProps) {
    const [activeSection, setActiveSection] = useState(sidebarItems[0]?.id || "");
    const mainContentRef = useRef<HTMLDivElement>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    // A clicked section stays marked until the reader moves the page from where the jump to it came to rest: a
    // section near the bottom can't reach the top, so its position alone would mark the one above it. The jump has
    // come to rest once no scroll has happened for SETTLE_MS (smooth scrolling and trackpad momentum included).
    const clickedRef = useRef<{ landing: number | null; timer: ReturnType<typeof setTimeout> | null } | null>(null);

    const armSettle = useCallback(() => {
        const clicked = clickedRef.current;
        if (!clicked) return;
        if (clicked.timer) clearTimeout(clicked.timer);
        clicked.timer = setTimeout(() => {
            clicked.timer = null;
            clicked.landing = scrollerRef.current?.scrollTop ?? 0;
        }, SETTLE_MS);
    }, []);

    const handleSectionClick = useCallback(
        (id: string) => {
            const element = document.getElementById(id);
            if (element) {
                if (clickedRef.current?.timer) clearTimeout(clickedRef.current.timer);
                clickedRef.current = { landing: null, timer: null };
                armSettle();
                element.scrollIntoView({ behavior: "smooth", block: "start" });
                setActiveSection(id);
            }
        },
        [armSettle],
    );

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
        scrollerRef.current = scrollContainer;

        const handleScroll = () => {
            const clicked = clickedRef.current;
            if (clicked) {
                if (clicked.landing === null) {
                    armSettle();
                    return;
                }
                if (Math.abs(scrollContainer.scrollTop - clicked.landing) <= MOVED_PX) return;
                clickedRef.current = null;
            }
            const containerRect = scrollContainer.getBoundingClientRect();
            const offset = 150;
            const atBottom =
                scrollContainer.scrollHeight > scrollContainer.clientHeight &&
                scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 2;

            let currentSection = visibleItems[0]?.id || "";

            for (const item of visibleItems) {
                const element = document.getElementById(item.id);
                if (element) {
                    const rect = element.getBoundingClientRect();
                    if (atBottom || rect.top <= containerRect.top + offset) {
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

        return () => {
            scrollContainer.removeEventListener("scroll", scrollHandler);
            if (clickedRef.current?.timer) clearTimeout(clickedRef.current.timer);
        };
    }, [sidebarItems, isAdmin, armSettle]);

    return (
        <div className="min-h-screen bg-[var(--bg-primary)]">
            <PageHeader title="Settings">
                <label className="mt-6 block md:hidden">
                    <span className="sr-only">Jump to section</span>
                    <select
                        value={activeSection}
                        onChange={(e) => handleSectionClick(e.target.value)}
                        className="w-full h-11 rounded-lg border border-white/10 bg-[#111] px-3 text-sm text-white"
                    >
                        {sidebarItems
                            .filter((item) => !item.adminOnly || isAdmin)
                            .map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.label.toLowerCase()}
                                </option>
                            ))}
                    </select>
                </label>
            </PageHeader>
            <div className="page-shell page-end flex gap-12">
                <SettingsSidebar
                    items={sidebarItems}
                    activeSection={activeSection}
                    onSectionClick={handleSectionClick}
                    isAdmin={isAdmin}
                />

                <div ref={mainContentRef} className="flex-1 min-w-0">
                    {children}
                </div>
            </div>
        </div>
    );
}
