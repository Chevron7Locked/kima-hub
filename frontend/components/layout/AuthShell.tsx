import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GalaxyBackground } from "@/components/ui/GalaxyBackground";

/** The signed-out pages' frame (sign-in, first-run setup): black with a faint brand wash, content centred on it. */
export function AuthShell({ galaxy = false, className, children }: { galaxy?: boolean; className?: string; children: ReactNode }) {
    return (
        <div className="min-h-screen w-full relative overflow-hidden">
            <div className="absolute inset-0 bg-[#000]">
                <div className="absolute inset-0 bg-gradient-to-br from-brand/5 via-transparent to-transparent" />
                {galaxy && (
                    <div className="opacity-[0.08]">
                        <GalaxyBackground primaryColor="#fca200" />
                    </div>
                )}
            </div>
            <div className={cn("relative z-(--z-raised) min-h-screen flex items-center justify-center", className)}>{children}</div>
        </div>
    );
}
