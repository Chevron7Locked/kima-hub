"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
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
}: ConfirmDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useDialog(dialogRef, isOpen, onClose, cancelRef);

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
        onConfirm();
        onClose();
    };

    // Drawn at the page's top level: inside an animated or clipped parent (a window, a panel), a fixed overlay is
    // sized and cut to that parent instead of the page.
    const overlay = (
        <div
            className="fixed inset-0 bg-black/75 flex items-center justify-center z-(--z-modal) p-4 transition-opacity duration-200"
            onClick={onClose}
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
                        onClick={onClose}
                        aria-label="Close dialog"
                        className="p-1 hover:bg-white/10 rounded-full transition-colors text-[var(--text-secondary)] hover:text-white flex-shrink-0"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex gap-3 p-6 bg-[var(--bg-primary)]/50">
                    <Button
                        variant="secondary"
                        ref={cancelRef}
                        onClick={onClose}
                        className="flex-1"
                    >
                        {cancelText}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleConfirm}
                        className={cn("flex-1", styles.confirmButton)}
                    >
                        {confirmText}
                    </Button>
                </div>
            </div>
        </div>
    );
    return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
