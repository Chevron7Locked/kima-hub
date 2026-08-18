"use client";

import { useState, useEffect } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";

export type StatusType = "idle" | "loading" | "success" | "error";

interface InlineStatusProps {
    status: StatusType;
    message?: string;
    className?: string;
    showIcon?: boolean;
    autoClear?: boolean; // Auto-clear success/error after delay
    clearDelay?: number; // Delay in ms before clearing (default 3000)
    onClear?: () => void;
}

/**
 * Inline status indicator for form fields and buttons
 * Shows success/error/loading states without overlay toasts
 */
export function InlineStatus({
    status,
    message,
    className,
    showIcon = true,
    autoClear = true,
    clearDelay = 3000,
    onClear,
}: InlineStatusProps) {
    const [visible, setVisible] = useState(status !== "idle");

    // Sync visibility with status changes during render
    const [prevStatus, setPrevStatus] = useState(status);
    if (status !== prevStatus) {
        setPrevStatus(status);
        setVisible(status !== "idle");
    }

    // Auto-clear success/error after delay
    useEffect(() => {
        if ((status === "success" || status === "error") && autoClear) {
            const timer = setTimeout(() => {
                setVisible(false);
                onClear?.();
            }, clearDelay);
            return () => clearTimeout(timer);
        }
    }, [status, autoClear, clearDelay, onClear]);

    if (status === "idle" || !visible) return null;

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 text-sm",
                status === "success" && "text-emerald-400",
                status === "error" && "text-red-400",
                status === "loading" && "text-[var(--text-secondary)]",
                className
            )}
            aria-live="polite"
        >
            {showIcon && (
                <>
                    {status === "success" && <Check className="w-4 h-4" />}
                    {status === "error" && <X className="w-4 h-4" />}
                    {status === "loading" && <Loader2 className="w-4 h-4 animate-spin" />}
                </>
            )}
            {message && <span>{message}</span>}
        </span>
    );
}

/**
 * Hook for managing inline status state
 */
export function useInlineStatus(initialStatus: StatusType = "idle") {
    const [status, setStatus] = useState<StatusType>(initialStatus);
    const [message, setMessage] = useState<string>("");

    const setSuccess = (msg?: string) => {
        setStatus("success");
        setMessage(msg || "");
    };

    const setError = (msg?: string) => {
        setStatus("error");
        setMessage(msg || "");
    };

    const setLoading = (msg?: string) => {
        setStatus("loading");
        setMessage(msg || "");
    };

    const reset = () => {
        setStatus("idle");
        setMessage("");
    };

    return {
        status,
        message,
        setSuccess,
        setError,
        setLoading,
        reset,
        props: { status, message, onClear: reset },
    };
}

/**
 * Connection test button with inline status
 */
interface ConnectionTestButtonProps {
    label: string;
    onTest: () => Promise<boolean | string | null>;
    className?: string;
    disabled?: boolean;
}

export function ConnectionTestButton({
    label,
    onTest,
    className,
    disabled,
}: ConnectionTestButtonProps) {
    const { status, setSuccess, setError, setLoading, props } = useInlineStatus();

    const handleTest = async () => {
        setLoading("Testing...");
        try {
            const result = await onTest();
            if (result === false || result === null) {
                setError("Failed");
            } else if (typeof result === "string") {
                setSuccess(result);
            } else {
                setSuccess("Connected");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed");
        }
    };

    return (
        <div className="flex items-center gap-3">
            <button
                onClick={handleTest}
                disabled={disabled || status === "loading"}
                className={cn(
                    "px-3 py-1.5 text-sm rounded-md transition-colors",
                    "bg-white/10 hover:bg-white/15 text-[var(--text-secondary)] hover:text-white",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    className
                )}
            >
                {status === "loading" ? "Testing..." : label}
            </button>
            <InlineStatus {...props} showIcon={true} />
        </div>
    );
}

/**
 * Save button with inline status
 */
interface SaveButtonProps {
    onSave: () => Promise<void>;
    label?: string;
    className?: string;
    disabled?: boolean;
}

export function SaveButton({
    onSave,
    label = "Save",
    className,
    disabled,
}: SaveButtonProps) {
    const { status, setSuccess, setError, setLoading, props } = useInlineStatus();

    const handleSave = async () => {
        setLoading();
        try {
            await onSave();
            setSuccess("Saved");
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed");
        }
    };

    return (
        <div className="flex items-center gap-3">
            <button
                onClick={handleSave}
                disabled={disabled || status === "loading"}
                className={cn(
                    "px-4 py-2 rounded-lg font-medium transition-colors",
                    "bg-amber-500 hover:bg-amber-400 text-black",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    className
                )}
            >
                {status === "loading" ? "Saving..." : label}
            </button>
            <InlineStatus {...props} showIcon={true} autoClear={true} />
        </div>
    );
}

