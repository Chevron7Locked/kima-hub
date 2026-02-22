"use client";

import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    footer?: ReactNode;
    className?: string;
}

export function Modal({
    isOpen,
    onClose,
    title,
    children,
    footer,
    className,
}: ModalProps) {
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };

        if (isOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "unset";
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 ">
            <div
                className={cn(
                    "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border border-[#262626] rounded-sm shadow-2xl max-w-md w-full p-6",
                    className
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#1c1c1c]">
                    <h2 className="text-lg font-medium text-white">{title}</h2>
                    <Button
                        variant="icon"
                        onClick={onClose}
                        className="hover:text-gray-300"
                    >
                        <X className="w-5 h-5" />
                    </Button>
                </div>

                {/* Content */}
                <div className="mb-6">{children}</div>

                {/* Footer */}
                {footer && (
                    <div className="flex gap-3 justify-end">{footer}</div>
                )}
            </div>
        </div>
    );
}
