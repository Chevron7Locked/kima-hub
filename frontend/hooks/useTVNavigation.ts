"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIsTV, DPAD_KEYS } from "@/lib/tv-utils";

interface UseTVNavigationOptions {
    onBack?: () => void;
    onSelect?: (element: HTMLElement) => void;
    enabled?: boolean;
}

interface UseTVNavigationResult {
    containerRef: React.RefObject<HTMLElement | null>;
    focusedSectionIndex: number;
    focusedCardIndex: number;
    isContentFocused: boolean;
    focusFirstCard: () => void;
    handleKeyDown: (e: KeyboardEvent) => void;
}

export function useTVNavigation(options: UseTVNavigationOptions = {}): UseTVNavigationResult {
    const { onBack, onSelect, enabled = true } = options;
    const isTV = useIsTV();

    const containerRef = useRef<HTMLElement>(null);
    const [focusedSectionIndex, setFocusedSectionIndex] = useState(0);
    const [focusedCardIndex, setFocusedCardIndex] = useState(0);
    const [isContentFocused, setIsContentFocused] = useState(false);

    // The last focused card in each section, by the section's own name: sections can appear or go while the
    // page is open (a row whose shows arrive later), so a position in the list would point at another row.
    const focusMemory = useRef<Map<string, number>>(new Map());

    // The latest props, synced before any timer can run, so a pending Back never reads stale ones.
    const onBackRef = useRef(onBack);
    const onSelectRef = useRef(onSelect);
    const enabledRef = useRef(enabled);
    useLayoutEffect(() => {
        onBackRef.current = onBack;
        onSelectRef.current = onSelect;
        enabledRef.current = enabled;
    });

    // A Back waiting for the key to reach every listener; dropped if the page goes away first.
    const pendingBack = useRef<ReturnType<typeof setTimeout> | null>(null);
    useLayoutEffect(() => () => {
        if (pendingBack.current) clearTimeout(pendingBack.current);
    }, []);

    const getSections = useCallback(() => {
        if (!containerRef.current) return [];
        return Array.from(
            containerRef.current.querySelectorAll<HTMLElement>('[data-tv-section]')
        );
    }, []);

    // Get all cards in a section with data-tv-card attribute
    const getCardsInSection = useCallback((section: HTMLElement) => {
        return Array.from(
            section.querySelectorAll<HTMLElement>('[data-tv-card]')
        );
    }, []);

    const scrollIntoView = useCallback((element: HTMLElement) => {
        element.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center'
        });
    }, []);

    const focusCard = useCallback((card: HTMLElement | null) => {
        if (card) {
            card.focus();
            scrollIntoView(card);
        }
    }, [scrollIntoView]);

    const focusFirstCard = useCallback(() => {
        const sections = getSections();
        if (sections.length === 0) {
            // Fallback: find any focusable element
            const firstFocusable = containerRef.current?.querySelector<HTMLElement>(
                'a[href], button, [tabindex="0"]'
            );
            if (firstFocusable) {
                firstFocusable.focus();
                setIsContentFocused(true);
            }
            return;
        }

        const firstSection = sections[0];
        const cards = getCardsInSection(firstSection);

        if (cards.length > 0) {
            focusCard(cards[0]);
            setFocusedSectionIndex(0);
            setFocusedCardIndex(0);
            setIsContentFocused(true);
        }
    }, [getSections, getCardsInSection, focusCard]);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!enabled || !isTV) return;

        // Back returns to the tab row from anywhere in the content (TVLayout sends keys here only when the tab row is not
        // focused), even when nothing is focused. Decided after every listener has seen the key: anything that used it (a
        // rename, a popover, a window) marks it handled, so Back never cancels Escape's own action.
        if (e.key === DPAD_KEYS.BACK) {
            if (pendingBack.current) clearTimeout(pendingBack.current);
            pendingBack.current = setTimeout(() => {
                pendingBack.current = null;
                if (e.defaultPrevented || !enabledRef.current) return;
                onBackRef.current?.();
                setIsContentFocused(false);
            }, 0);
            return;
        }

        // If not content focused, ignore - let TVLayout handle it
        if (!isContentFocused) return;

        const sections = getSections();
        if (sections.length === 0) {
            // No sections found, try fallback navigation
            const focusables = containerRef.current?.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), [tabindex="0"]'
            );
            if (!focusables || focusables.length === 0) return;

            const currentIdx = Array.from(focusables).findIndex(el => el === document.activeElement);
            if (currentIdx === -1) return;

            if (e.key === DPAD_KEYS.RIGHT) {
                e.preventDefault();
                const next = focusables[Math.min(currentIdx + 1, focusables.length - 1)];
                next?.focus();
            } else if (e.key === DPAD_KEYS.LEFT) {
                e.preventDefault();
                const prev = focusables[Math.max(currentIdx - 1, 0)];
                prev?.focus();
            } else if (e.key === DPAD_KEYS.UP) {
                e.preventDefault();
                onBackRef.current?.();
                setIsContentFocused(false);
            }
            return;
        }

        // Where the focus really is, read from the page on every press: sections that appeared or went since the
        // last move would leave a stored position pointing at another row.
        const active = document.activeElement as HTMLElement | null;
        let sectionIndex = sections.findIndex((s) => active !== null && s.contains(active));
        if (sectionIndex === -1) sectionIndex = Math.min(focusedSectionIndex, sections.length - 1);
        const currentSection = sections[sectionIndex];
        if (!currentSection) return;
        const nameOf = (section: HTMLElement) => section.getAttribute('data-tv-section') ?? '';

        const cards = getCardsInSection(currentSection);
        const activeCard = active ? cards.indexOf(active) : -1;
        // Focus on something in the section that is not a card (a "show all" link) sits before its first card (-1):
        // right or left goes to card 0, up or down to column 0. A stored column belongs to wherever the focus was.
        const insideSection = active !== null && currentSection.contains(active);
        const cardIndex = activeCard !== -1 ? activeCard : insideSection ? -1 : Math.min(focusedCardIndex, Math.max(cards.length - 1, 0));
        const column = Math.max(cardIndex, 0);

        switch (e.key) {
            case DPAD_KEYS.RIGHT: {
                e.preventDefault();
                const nextIndex = Math.min(cardIndex + 1, cards.length - 1);
                if (nextIndex !== cardIndex) {
                    focusCard(cards[nextIndex]);
                    setFocusedCardIndex(nextIndex);
                    focusMemory.current.set(nameOf(currentSection), nextIndex);
                }
                break;
            }

            case DPAD_KEYS.LEFT: {
                e.preventDefault();
                const prevIndex = Math.max(cardIndex - 1, 0);
                if (prevIndex !== cardIndex) {
                    focusCard(cards[prevIndex]);
                    setFocusedCardIndex(prevIndex);
                    focusMemory.current.set(nameOf(currentSection), prevIndex);
                }
                break;
            }

            case DPAD_KEYS.DOWN:
            case DPAD_KEYS.UP: {
                e.preventDefault();
                const step = e.key === DPAD_KEYS.DOWN ? 1 : -1;
                // The nearest row that way with cards to focus: a row still loading has none, and is stepped over.
                let targetSectionIndex = sectionIndex + step;
                while (
                    targetSectionIndex >= 0 &&
                    targetSectionIndex < sections.length &&
                    getCardsInSection(sections[targetSectionIndex]).length === 0
                ) {
                    targetSectionIndex += step;
                }
                if (targetSectionIndex >= 0 && targetSectionIndex < sections.length) {
                    focusMemory.current.set(nameOf(currentSection), column);
                    const targetSection = sections[targetSectionIndex];
                    const targetCards = getCardsInSection(targetSection);
                    // Restore the row's saved position, or keep the current column, clamped to the row.
                    const savedIndex = focusMemory.current.get(nameOf(targetSection));
                    const targetIndex = Math.min(savedIndex ?? column, targetCards.length - 1);

                    focusCard(targetCards[targetIndex]);
                    setFocusedSectionIndex(targetSectionIndex);
                    setFocusedCardIndex(targetIndex);
                } else if (step < 0) {
                    // Above the top row, back to the nav.
                    onBackRef.current?.();
                    setIsContentFocused(false);
                }
                break;
            }

            case DPAD_KEYS.CENTER:
            case 'Enter': {
                const focusedElement = document.activeElement as HTMLElement;
                if (focusedElement) {
                    // If it's a link, let the default behavior happen
                    if (focusedElement.tagName === 'A') {
                        return; // Allow default navigation
                    }
                    // Otherwise trigger onSelect
                    onSelectRef.current?.(focusedElement);
                }
                break;
            }
        }
    }, [
        enabled, isTV, isContentFocused, focusedSectionIndex, focusedCardIndex,
        getSections, getCardsInSection, focusCard
    ]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !isTV) return;

        const handleFocusIn = (e: FocusEvent) => {
            const target = e.target as HTMLElement;
            if (target.hasAttribute('data-tv-card')) {
                setIsContentFocused(true);

                const sections = getSections();
                for (let sIdx = 0; sIdx < sections.length; sIdx++) {
                    const cards = getCardsInSection(sections[sIdx]);
                    const cIdx = cards.indexOf(target);
                    if (cIdx !== -1) {
                        setFocusedSectionIndex(sIdx);
                        setFocusedCardIndex(cIdx);
                        break;
                    }
                }
            }
        };

        const handleFocusOut = (e: FocusEvent) => {
            // Check if focus is leaving the container entirely
            const relatedTarget = e.relatedTarget as HTMLElement;
            if (!container.contains(relatedTarget)) {
                setIsContentFocused(false);
            }
        };

        container.addEventListener('focusin', handleFocusIn);
        container.addEventListener('focusout', handleFocusOut);

        return () => {
            container.removeEventListener('focusin', handleFocusIn);
            container.removeEventListener('focusout', handleFocusOut);
        };
    }, [isTV, getSections, getCardsInSection]);

    return {
        containerRef,
        focusedSectionIndex,
        focusedCardIndex,
        isContentFocused,
        focusFirstCard,
        handleKeyDown
    };
}
