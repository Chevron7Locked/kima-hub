"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

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

    // Focus the cancel button when opened
    useEffect(() => {
        if (isOpen) {
            cancelRef.current?.focus();
        }
    }, [isOpen]);

    // Close on Escape; trap focus within the dialog
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
            }
            if (e.key === "Tab" && dialogRef.current) {
                const focusable = Array.from(
                    dialogRef.current.querySelectorAll<HTMLElement>(
                        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                    )
                ).filter((el) => !el.hasAttribute("disabled"));
                if (focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const variantStyles = {
        danger: {
            icon: "text-red-500",
            iconBg: "bg-red-500/10",
            confirmButton: "bg-red-500 hover:bg-red-600 text-white",
        },
        warning: {
            icon: "text-yellow-500",
            iconBg: "bg-yellow-500/10",
            confirmButton: "bg-yellow-500 hover:bg-yellow-600 text-black",
        },
        info: {
            icon: "text-blue-500",
            iconBg: "bg-blue-500/10",
            confirmButton: "bg-blue-500 hover:bg-blue-600 text-white",
        },
    };

    const styles = variantStyles[variant];

    const handleConfirm = () => {
        onConfirm();
        onClose();
    };

    return (
        <div
            className="fixed inset-0 bg-black/75 flex items-center justify-center z-[80] p-4 animate-fadeIn"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
                aria-describedby="confirm-dialog-message"
                className="bg-[#121212] rounded-xl max-w-md w-full overflow-hidden border border-white/10 shadow-2xl animate-slideUp"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
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

                {/* Actions */}
                <div className="flex gap-3 p-6 bg-[var(--bg-primary)]/50">
                    <button
                        ref={cancelRef}
                        onClick={onClose}
                        className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 text-white font-semibold rounded-lg transition-all border border-white/10"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={handleConfirm}
                        className={`flex-1 px-4 py-3 font-semibold rounded-lg transition-all ${styles.confirmButton}`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>

            <style jsx global>{`
                @keyframes fadeIn {
                    from {
                        opacity: 0;
                    }
                    to {
                        opacity: 1;
                    }
                }

                @keyframes slideUp {
                    from {
                        transform: translateY(20px);
                        opacity: 0;
                    }
                    to {
                        transform: translateY(0);
                        opacity: 1;
                    }
                }

                .animate-fadeIn {
                    animation: fadeIn 0.2s ease-out;
                }

                .animate-slideUp {
                    animation: slideUp 0.3s ease-out;
                }
            `}</style>
        </div>
    );
}
