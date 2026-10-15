import { useEffect, useRef, useState, type RefObject } from "react";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// The dialogs open now, oldest first. Escape belongs to the newest alone.
const openDialogs: symbol[] = [];

/* Modal dialog behaviour: Escape closes, Tab stays inside the dialog, the page
 * behind does not scroll, and focus returns to whatever opened it. */
export function useDialog(
    dialogRef: RefObject<HTMLElement | null>,
    isOpen: boolean,
    onClose: () => void,
    initialFocusRef?: RefObject<HTMLElement | null>,
) {
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    /* Recorded while closed, because an autoFocus field inside the dialog takes
     * focus before effects run; a dialog that mounts already open records it at
     * its first render, before anything inside it can take focus. */
    const [mountedWithFocusOn] = useState(() =>
        typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
    );
    const openerRef = useRef<HTMLElement | null>(mountedWithFocusOn);
    useEffect(() => {
        if (isOpen) return;
        const track = (e: FocusEvent) => {
            const el = e.target as HTMLElement;
            if (!el.closest?.('[role="dialog"]')) openerRef.current = el;
        };
        openerRef.current = document.activeElement as HTMLElement | null;
        document.addEventListener("focusin", track);
        return () => document.removeEventListener("focusin", track);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const opener = openerRef.current;
        const focusables = () =>
            Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
                (el) => !el.hasAttribute("disabled"),
            );
        if (!dialogRef.current?.contains(document.activeElement)) {
            (initialFocusRef?.current ?? focusables()[0] ?? dialogRef.current)?.focus();
        }

        // Escape is caught on its way down to the page, before any other listener, and only the newest open dialog
        // answers it: the page, a window or a menu behind it, or a dialog under it, never also closes on the same key.
        const self = Symbol("dialog");
        openDialogs.push(self);
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || openDialogs[openDialogs.length - 1] !== self) return;
            e.preventDefault();
            e.stopPropagation();
            onCloseRef.current();
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Tab") return;
            const items = focusables();
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };

        const overflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        document.addEventListener("keydown", handleEscape, true);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            openDialogs.splice(openDialogs.indexOf(self), 1);
            document.removeEventListener("keydown", handleEscape, true);
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = overflow;
            opener?.focus();
        };
    }, [isOpen, dialogRef, initialFocusRef]);
}
