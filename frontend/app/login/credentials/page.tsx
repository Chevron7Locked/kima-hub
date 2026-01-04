"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Loader2, ArrowLeft } from "lucide-react";
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

export default function CredentialsLoginPage() {
    const { login } = useAuth();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [requires2FA, setRequires2FA] = useState(false);
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setIsSubmitting(true);

        try {
            await login(username, password, twoFactorToken || undefined);
        } catch (err: any) {
            if (err.message === "2FA token required") {
                setRequires2FA(true);
                setError("");
            } else {
                setError(err.message || "Invalid credentials");
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <AuthPageTemplate
            title={requires2FA ? "Two-Factor Authentication" : "Sign in with credentials"}
            subtitle={requires2FA ? "Enter your verification code" : "Enter your username and password"}
        >
            <Suspense fallback={null}>
                <LoginErrorHandler setError={setError} />
            </Suspense>

            <div className="w-full max-w-md mx-auto">
                {/* Back to provider selection */}
                <Link
                    href="/login"
                    className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to login options
                </Link>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    {!requires2FA ? (
                        <>
                            <div>
                                <label
                                    htmlFor="username"
                                    className="block text-sm font-medium text-gray-300 mb-2"
                                >
                                    Username
                                </label>
                                <input
                                    id="username"
                                    type="text"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#ecb200] focus:border-transparent transition-all"
                                    placeholder="Enter your username"
                                    required
                                    autoComplete="username"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="password"
                                    className="block text-sm font-medium text-gray-300 mb-2"
                                >
                                    Password
                                </label>
                                <input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#ecb200] focus:border-transparent transition-all"
                                    placeholder="Enter your password"
                                    required
                                    autoComplete="current-password"
                                />
                            </div>
                        </>
                    ) : (
                        <div>
                            <label
                                htmlFor="token"
                                className="block text-sm font-medium text-gray-300 mb-2"
                            >
                                {useRecoveryCode ? "Recovery Code" : "Verification Code"}
                            </label>
                            <input
                                id="token"
                                type="text"
                                value={twoFactorToken}
                                onChange={(e) => setTwoFactorToken(e.target.value)}
                                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#ecb200] focus:border-transparent transition-all text-center text-2xl tracking-widest"
                                placeholder={useRecoveryCode ? "XXXXX-XXXXX" : "000000"}
                                required
                                autoComplete="one-time-code"
                                autoFocus
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    setUseRecoveryCode(!useRecoveryCode);
                                    setTwoFactorToken("");
                                }}
                                className="mt-2 text-sm text-[#ecb200] hover:text-[#d4a000] transition-colors"
                            >
                                {useRecoveryCode
                                    ? "Use authenticator code instead"
                                    : "Use recovery code instead"}
                            </button>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="w-full px-6 py-3 bg-[#ecb200] hover:bg-[#d4a000] text-black font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                Signing in...
                            </>
                        ) : (
                            "Sign in"
                        )}
                    </button>
                </form>
            </div>
        </AuthPageTemplate>
    );
}
