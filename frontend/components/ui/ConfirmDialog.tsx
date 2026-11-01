"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useDialog } from "@/hooks/useDialog";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "danger" | "warning" | "info";
    /** A confirmed action is running: both buttons lock and the confirm button shows it. */
    busy?: boolean;
    /** False when the caller closes the dialog itself, e.g. only once an action succeeded. */
    closeOnConfirm?: boolean;
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "danger",
    busy = false,
    closeOnConfirm = true,
}: ConfirmDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    // While the confirmed action runs, nothing closes the dialog: its outcome (or a retry) lands in it. The buttons
    // stay focusable (aria-disabled, not disabled) so keyboard focus never falls out of the dialog.
    const dismiss = () => {
        if (!busy) onClose();
    };
    useDialog(dialogRef, isOpen, dismiss, cancelRef);

    if (!isOpen) return null;

    const variantStyles = {
        danger: {
            icon: "text-danger",
            iconBg: "bg-danger/10",
            confirmButton: "bg-danger hover:bg-danger/90 text-white",
        },
        warning: {
            icon: "text-warning",
            iconBg: "bg-warning/10",
            confirmButton: "bg-warning hover:bg-warning/90 text-black",
        },
        info: {
            icon: "text-brand",
            iconBg: "bg-brand/10",
            confirmButton: "bg-brand hover:bg-brand-hover text-black",
        },
    };

    const styles = variantStyles[variant];

    const handleConfirm = () => {
        if (busy) return;
        onConfirm();
        if (closeOnConfirm) onClose();
    };

    // Drawn at the page's top level: inside an animated or clipped parent (a window, a panel), a fixed overlay is
    // sized and cut to that parent instead of the page.
    const overlay = (
        <div
            className="fixed inset-0 bg-black/75 flex items-center justify-center z-(--z-modal) p-4 transition-opacity duration-200"
            onClick={dismiss}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
                aria-describedby="confirm-dialog-message"
                className="bg-[#121212] rounded-xl max-w-md w-full overflow-hidden border border-white/10 animate-pop"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start gap-4 p-6 border-b border-white/10">
                    <div
                        className={`w-12 h-12 rounded-full ${styles.iconBg} flex items-center justify-center flex-shrink-0`}
                    >
                        <AlertTriangle className={`w-6 h-6 ${styles.icon}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 id="confirm-dialog-title" className="text-xl font-bold text-white mb-2">
                            {title}
                        </h2>
                        <p id="confirm-dialog-message" className="text-sm text-[var(--text-secondary)]">{message}</p>
                    </div>
                    <button
                        onClick={dismiss}
                        aria-disabled={busy || undefined}
                        aria-label="Close dialog"
                        className={cn(
                            "p-1 rounded-full transition-colors text-[var(--text-secondary)] flex-shrink-0",
                            busy ? "opacity-50 cursor-not-allowed" : "hover:bg-white/10 hover:text-white",
                        )}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex gap-3 p-6 bg-[var(--bg-primary)]/50">
                    <Button
                        variant="secondary"
                        ref={cancelRef}
                        onClick={dismiss}
                        aria-disabled={busy || undefined}
                        className={cn("flex-1", busy && "opacity-50 cursor-not-allowed")}
                    >
                        {cancelText}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleConfirm}
                        aria-disabled={busy || undefined}
                        aria-busy={busy || undefined}
                        className={cn("flex-1", styles.confirmButton)}
                    >
                        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                        {confirmText}
                    </Button>
                </div>
            </div>
        </div>
    );
    return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
