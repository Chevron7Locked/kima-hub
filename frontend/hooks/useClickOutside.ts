import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * While `enabled`, calls `onOutside` when a press lands outside every element in `refs` (all of them mounted).
 * The latest `onOutside` and `refs` are used without re-subscribing.
 */
export function useClickOutside(
    refs: ReadonlyArray<RefObject<HTMLElement | null>>,
    onOutside: () => void,
    enabled = true,
): void {
    const latest = useRef({ refs, onOutside });
    useLayoutEffect(() => {
        latest.current = { refs, onOutside };
    });
    useEffect(() => {
        if (!enabled) return;
        const press = (e: MouseEvent) => {
            const target = e.target as Node;
            const { refs: current, onOutside: handle } = latest.current;
            if (current.every((ref) => ref.current && !ref.current.contains(target))) handle();
        };
        document.addEventListener("mousedown", press);
        return () => document.removeEventListener("mousedown", press);
    }, [enabled]);
}
