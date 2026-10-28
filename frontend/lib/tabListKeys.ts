import type React from "react";

/**
 * The keyboard half of the ARIA tabs pattern, for a row of role="tab" buttons: Left and Right move to the previous or
 * next tab (wrapping), Home and End to the first or last; the tab is chosen and focused. Put this on the tablist, give
 * each tab `data-tab-key={key}`, and keep only the chosen tab in the Tab order (tabIndex 0, the others -1).
 */
export function tabListKeyDown<K extends string>(
    e: React.KeyboardEvent<HTMLElement>,
    keys: readonly K[],
    current: K,
    choose: (key: K) => void,
): void {
    if (keys.length === 0) return;
    const at = Math.max(0, keys.indexOf(current));
    const next =
        e.key === "ArrowRight" ? (at + 1) % keys.length
        : e.key === "ArrowLeft" ? (at - 1 + keys.length) % keys.length
        : e.key === "Home" ? 0
        : e.key === "End" ? keys.length - 1
        : null;
    if (next === null) return;
    e.preventDefault();
    choose(keys[next]);
    e.currentTarget.querySelector<HTMLElement>(`[data-tab-key="${keys[next]}"]`)?.focus();
}
