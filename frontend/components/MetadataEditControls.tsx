"use client";

import { ComponentProps, lazy, Suspense } from "react";
import type { MetadataEditor as Editor } from "@/components/MetadataEditor";
import { useAuth } from "@/lib/auth-context";

// The editor is a modal opened on demand, so it loads only when a page can show it.
const MetadataEditor = lazy(() => import("@/components/MetadataEditor").then((mod) => ({ default: mod.MetadataEditor })));

type MetadataEditControlsProps = ComponentProps<typeof Editor> & {
    edited: boolean;
    editable: boolean;
};

/** The "edited" mark and the edit button beside an album or artist title. Editing is admin-only on the server. */
export function MetadataEditControls({ edited, editable, ...editor }: MetadataEditControlsProps) {
    const { user } = useAuth();
    return (
        <>
            {edited && (
                <span className="px-2 py-0.5 text-xs bg-white/10 text-[var(--text-secondary)] rounded-full border border-white/10 shrink-0">
                    Edited
                </span>
            )}
            {editable && user?.role === "admin" && (
                <Suspense fallback={null}>
                    <MetadataEditor {...editor} />
                </Suspense>
            )}
        </>
    );
}
