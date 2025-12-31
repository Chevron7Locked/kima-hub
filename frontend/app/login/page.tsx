"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AUTH_PROVIDERS, AuthProvider, startOIDCLogin } from "@/lib/auth/oidc-client";
import { Loader2, Key } from "lucide-react";
import { AuthPageTemplate } from "@/components/auth/AuthPageTemplate";
import Link from "next/link";

// Separate component to handle search params (needs Suspense boundary)
function LoginErrorHandler({
    setError,
}: {
    setError: (error: string) => void;
}) {
    const searchParams = useSearchParams();

    useEffect(() => {
        const errorParam = searchParams.get("error");
        if (errorParam) {
            setError(decodeURIComponent(errorParam));
        }
    }, [searchParams, setError]);

    return null;
}

export default function LoginPage() {
    const [providers, setProviders] = useState<AuthProvider[]>([]);
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(true);

    // Fetch providers on mount
    useEffect(() => {
        const fetchProviders = async () => {
            try {
                const authProviders = await AUTH_PROVIDERS;
                setProviders(authProviders);

                // Auto-redirect based on available providers
                const oidcProviders = authProviders.filter((p: AuthProvider) => p.type === "oidc");
                const credentialsProvider = authProviders.find((p: AuthProvider) => p.type === "credentials");

                // If only credentials, redirect to credentials page
                if (credentialsProvider && oidcProviders.length === 0) {
                    // Provide user feedback before redirecting
                    setError("Redirecting to credentials login...");
                    window.location.href = "/login/credentials";
                    return;
                }

                // If only one OIDC provider and no credentials, auto-start OIDC flow
                if (oidcProviders.length === 1 && !credentialsProvider) {
                    // Provide user feedback before starting OIDC login
                    setError("Redirecting to SSO login...");
                    await startOIDCLogin(oidcProviders[0]);
                    return;
                }
            } catch (err) {
                console.error("Failed to fetch providers:", err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchProviders();
    }, []);

    const handleOIDCLogin = async (provider: AuthProvider) => {
        try {
            await startOIDCLogin(provider);
        } catch (err) {
            console.error("OIDC login failed:", err);
            const message =
                err instanceof Error && err.message ? err.message : String(err);
            setError(`Failed to start OIDC login: ${message}`);
        }
    };

    if (isLoading) {
        return (
            <AuthPageTemplate
                title="Loading..."
                subtitle="Please wait"
                showArtistBackground={false}
            >
                <div className="flex justify-center py-8">
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                </div>
            </AuthPageTemplate>
        );
    }

    const oidcProviders = providers.filter(p => p.type === "oidc");
    const hasCredentials = providers.some(p => p.type === "credentials");

    return (
        <AuthPageTemplate
            title="Sign in to Lidify"
            subtitle="Choose your authentication method"
        >
            <Suspense fallback={null}>
                <LoginErrorHandler setError={setError} />
            </Suspense>

            <div className="w-full max-w-md mx-auto space-y-4">
                {error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                        {error}
                    </div>
                )}

                {/* OIDC Providers */}
                {oidcProviders.length > 0 && (
                    <div className="space-y-3">
                        {oidcProviders.map((provider) => (
                            <button
                                key={provider.id}
                                onClick={() => handleOIDCLogin(provider)}
                                className="w-full px-6 py-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#ecb200]/50 text-white font-semibold rounded-lg transition-all flex items-center justify-center gap-3 group"
                            >
                                <svg
                                    className="w-5 h-5 text-[#ecb200]"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                                    />
                                </svg>
                                {provider.name}
                            </button>
                        ))}
                    </div>
                )}

                {/* Divider */}
                {oidcProviders.length > 0 && hasCredentials && (
                    <div className="relative py-4">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-white/10"></div>
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="px-4 bg-black text-gray-400">Or</span>
                        </div>
                    </div>
                )}

                {/* Credentials Option */}
                {hasCredentials && (
                    <Link
                        href="/login/credentials"
                        className="w-full px-6 py-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#ecb200]/50 text-white font-semibold rounded-lg transition-all flex items-center justify-center gap-3 group"
                    >
                        <Key className="w-5 h-5 text-[#ecb200]" />
                        Lidify
                    </Link>
                )}
            </div>
        </AuthPageTemplate>
    );
}
