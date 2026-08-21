"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";

interface OperationConfirmToastProps {
    currentOpName: string;
    newOpName: string;
    onConfirm: () => void;
    onCancel: () => void;
}

function getOperationName(type: string): string {
    switch (type) {
        case "vibe":
            return "Vibe";
        case "drift":
            return "Drift";
        case "blend":
            return "Blend";
        case "similar":
            return "Similar";
        default:
            return "";
    }
}

export function OperationConfirmToast({
    currentOpName,
    newOpName,
    onConfirm,
    onCancel,
}: OperationConfirmToastProps) {
    const [visible, setVisible] = useState(false);
    const onCancelRef = useRef(onCancel);

    useEffect(() => {
        onCancelRef.current = onCancel;
    }, [onCancel]);

    useEffect(() => {
        const frame = requestAnimationFrame(() => setVisible(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            onCancelRef.current();
        }, 5000);
        return () => clearTimeout(timer);
    }, []);

    return (
        <div
            className={cn(
                "fixed bottom-24 left-1/2 -translate-x-1/2 z-(--z-drawer-backdrop)",
                "bg-[var(--bg-hover)] border border-white/10 rounded-lg",
                "px-4 py-3 flex items-center gap-3",
                "transition-all duration-300 ease-out",
                visible
                    ? "translate-y-0 opacity-100"
                    : "translate-y-4 opacity-0",
            )}
        >
            <span className="text-sm text-[var(--text-primary)] whitespace-nowrap">
                Replace {getOperationName(currentOpName)} with{" "}
                {getOperationName(newOpName)}?
            </span>
            <button
                onClick={onConfirm}
                className="px-3 py-1 bg-brand text-black text-sm font-medium rounded hover:bg-[var(--color-brand)]/90 transition-colors"
            >
                Replace
            </button>
            <button
                onClick={onCancel}
                className="px-3 py-1 text-[var(--text-secondary)] text-sm hover:text-white transition-colors"
            >
                Cancel
            </button>
        </div>
    );
}
