"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsToggle } from "@/features/settings/components/ui";

const KEY = ["analysis-together"] as const;

export const BOTH_AT_ONCE_LABEL = "Run audio analysis and sound vectors at the same time";
export const BOTH_AT_ONCE_DESCRIPTION =
    "Off: Kima analyses your songs first, then makes their sound vectors, so each job has the machine to itself.";

/**
 * The admin switch for running both heavy enrichment jobs side by side. Turning it on asks first, because both
 * then share the processor and the graphics card for the whole run; turning it off saves at once. Settings and the
 * release window show the same switch and share its state.
 */
export function BothAtOnceSwitch({ id }: { id: string }) {
    const queryClient = useQueryClient();
    const [asking, setAsking] = useState(false);
    const { data, isError: unread, refetch } = useQuery({ queryKey: KEY, queryFn: () => api.getAnalysisTogether(), staleTime: 0 });
    const save = useMutation({
        mutationFn: (together: boolean) => api.setAnalysisTogether(together),
        onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
    });
    const on = save.isPending ? save.variables === true : data?.together === true;

    return (
        <>
            <SettingsToggle
                id={id}
                checked={on}
                disabled={!data || save.isPending}
                onChange={(checked) => (checked ? setAsking(true) : save.mutate(false))}
            />
            {save.isError && <p className="text-xs text-danger-light mt-1">Couldn&apos;t save that. Try again.</p>}
            {unread && !data && (
                <p className="text-xs text-danger-light mt-1">
                    Couldn&apos;t read this setting.{" "}
                    <button type="button" onClick={() => void refetch()} className="underline text-brand">
                        Try again
                    </button>
                </p>
            )}
            {asking && (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setAsking(false)}
                    onConfirm={() => {
                        setAsking(false);
                        save.mutate(true);
                    }}
                    title="Run both at the same time?"
                    message={
                        "Audio analysis and sound vectors are the two heaviest jobs Kima runs. At the same time, " +
                        "they share your processor and graphics card for the whole run, so your server works much " +
                        "harder: music, other apps on it and the machine itself can slow down, and it runs hotter " +
                        "and louder until the run finishes. You can turn this off any time."
                    }
                    confirmText="Run both at once"
                    cancelText="Keep one at a time"
                    variant="warning"
                />
            )}
        </>
    );
}
