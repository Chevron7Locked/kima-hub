"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

function CallbackInner() {
    const params = useSearchParams();
    const router = useRouter();
    const { completeOidcLogin } = useAuth();

    const code = params.get("code");
    const state = params.get("state");
    const providerError = params.get("error");
    const errorDescription = params.get("error_description");

    // Derive any up-front error during render so the effect doesn't setState
    // synchronously (the only setState in the effect is the async .catch).
    const initialError = providerError
        ? errorDescription || providerError
        : !code || !state
          ? "Missing authorization response"
          : null;

    const [error, setError] = useState<string | null>(initialError);
    const ran = useRef(false);

    useEffect(() => {
        if (ran.current || initialError || !code || !state) return;
        ran.current = true; // guard StrictMode double-invoke (code is single-use)
        completeOidcLogin(code, state).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : "SSO login failed");
        });
    }, [code, state, initialError, completeOidcLogin]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-black text-white">
            <div className="text-center space-y-4">
                {error ? (
                    <>
                        <p className="text-sm font-mono text-red-400 uppercase tracking-wider">
                            {error}
                        </p>
                        <button
                            onClick={() => router.push("/login")}
                            className="px-4 py-2 text-xs font-mono bg-white/5 border border-white/10 text-white/70 rounded-lg uppercase tracking-wider hover:bg-white/10 hover:text-white transition-all"
                        >
                            Back to login
                        </button>
                    </>
                ) : (
                    <p className="text-sm font-mono text-white/50 uppercase tracking-wider animate-pulse">
                        Signing you in…
                    </p>
                )}
            </div>
        </div>
    );
}

export default function OidcCallbackPage() {
    return (
        <Suspense fallback={null}>
            <CallbackInner />
        </Suspense>
    );
}
