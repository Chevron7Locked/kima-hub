"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";

/** A small "copy" link-button that says "copied" for two seconds once the text is on the clipboard. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(timer);
    }, [copied]);
    return (
        <button
            type="button"
            onClick={async () => setCopied(await copyText(text))}
            className={cn("text-xs text-brand hover:text-brand-hover transition-colors shrink-0", className)}
        >
            {copied ? "Copied" : label}
        </button>
    );
}
