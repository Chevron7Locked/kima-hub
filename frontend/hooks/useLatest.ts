import { useLayoutEffect, useRef } from "react";

/**
 * A ref that always holds the value from the latest render, set before any event can fire. A memoised row hands its
 * buttons one handler that never changes and has that handler read what to call from here, so a press runs the list's
 * current callback and never a copy from the render the row last drew with. Read `.current` in event handlers only,
 * never while rendering: what a row draws has to come in as a prop, so the row's memo comparison sees it change.
 */
export function useLatest<T>(value: T): { readonly current: T } {
    const ref = useRef(value);
    useLayoutEffect(() => {
        ref.current = value;
    });
    return ref;
}
