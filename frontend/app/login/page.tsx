"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { KimaMark } from "@/components/ui/KimaMark";

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
    "session_expired": "Your session has expired. Please sign in again.",
    "unauthorized": "You must be signed in to access that page.",
    "account_disabled": "Your account has been disabled.",
    "invalid_token": "Invalid authentication token.",
};

// Separate component to handle search params (needs Suspense boundary)
function LoginErrorHandler({
    setError,
}: {
    setError: (error: string) => void;
}) {
    const searchParams = useSearchParams();

    useEffect(() => {
        const errorCode = searchParams.get("error");
        if (errorCode) {
            const message = LOGIN_ERROR_MESSAGES[errorCode] ?? "An error occurred. Please try again.";
            setError(message);
        }
    }, [searchParams, setError]);

    return null;
}

export default function LoginPage() {
    const { login } = useAuth();
    const router = useRouter();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [requires2FA, setRequires2FA] = useState(false);
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true);

    // Defense in depth: Check if onboarding is needed
    // If no users exist, redirect to onboarding instead of showing login
    useEffect(() => {
        const checkOnboarding = async () => {
            try {
                const status = await api.get<{ hasAccount: boolean }>(
                    "/onboarding/status"
                );
                if (!status.hasAccount) {
                    router.replace("/onboarding");
                    return;
                }
            } catch {
                // If check fails, show login form (fail open)
            }
            setIsCheckingOnboarding(false);
        };
        checkOnboarding();
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setIsLoading(true);

        try {
            // First step: Send username and password
            if (!requires2FA) {
                await login(username, password);
                // If we get here, either:
                // 1. Login succeeded (no 2FA)
                // 2. We'll catch the requires2FA response below
            } else {
                // Second step: Send 2FA token
                await login(username, password, twoFactorToken);
                // If successful, login() will redirect
            }
        } catch (err) {
            const errorMsg =
                err instanceof Error ? err.message : "Login failed";

            // Check if 2FA is required
            if (
                errorMsg.includes("2FA token required") ||
                errorMsg.includes("requires2FA")
            ) {
                setRequires2FA(true);
                setError("");
            } else if (
                errorMsg.includes("Invalid 2FA token") ||
                errorMsg.includes("Invalid recovery code")
            ) {
                setError(errorMsg);
                setTwoFactorToken(""); // Clear the token for retry
            } else {
                setError(errorMsg);
                setRequires2FA(false);
                setTwoFactorToken("");
            }
        } finally {
            setIsLoading(false);
        }
    };

    if (isCheckingOnboarding) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-black">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <AuthShell galaxy className="p-4">
            <Suspense fallback={null}>
                <LoginErrorHandler setError={setError} />
            </Suspense>
            <div className="w-full max-w-md">
                <div className="flex items-center justify-center mb-8">
                    <div className="relative flex gap-3 items-center group">
                        <div className="relative">
                            <div className="absolute inset-0 bg-white/10 blur-xl rounded-full group-hover:bg-white/20 transition-all duration-300" />
                            <KimaMark size={40} className="relative z-(--z-raised)" />
                        </div>
                        <span className="text-3xl font-bold text-white">
                            Kima
                        </span>
                    </div>
                </div>

                <div className="bg-[#111]/90 rounded-lg p-6 md:p-8 border border-white/10 animate-rise transition-shadow duration-200">
                    <h1 className="text-2xl font-bold text-white mb-1 text-center">
                        Welcome back
                    </h1>
                    <p className="text-[var(--text-secondary)] text-center mb-8">
                        Sign in to continue to Kima
                    </p>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {error && (
                            <div className="bg-danger/10  border border-danger/30 rounded-lg p-4 text-sm text-danger-light animate-shake">
                                {error}
                            </div>
                        )}

                        {/* Step 1: Username & Password */}
                        {!requires2FA && (
                            <>
                                <div>
                                    <label
                                        htmlFor="username"
                                        className="block text-sm font-medium text-[var(--text-primary)] mb-1.5"
                                    >
                                        Username
                                    </label>
                                    <input
                                        id="username"
                                        type="text"
                                        value={username}
                                        onChange={(e) =>
                                            setUsername(e.target.value)
                                        }
                                        placeholder="Enter your username"
                                        required
                                        autoFocus
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200 "
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="password"
                                        className="block text-sm font-medium text-[var(--text-primary)] mb-1.5"
                                    >
                                        Password
                                    </label>
                                    <input
                                        id="password"
                                        type="password"
                                        value={password}
                                        onChange={(e) =>
                                            setPassword(e.target.value)
                                        }
                                        placeholder="Enter your password"
                                        required
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200 "
                                    />
                                </div>
                            </>
                        )}

                        {/* Step 2: 2FA Token Input */}
                        {requires2FA && (
                            <div className="animate-fade-in space-y-4">
                                <div className="p-4 bg-brand/10 border border-brand/20 rounded-lg">
                                    <p className="text-[var(--text-primary)] text-sm font-semibold mb-1">
                                        Two-Factor Authentication Required
                                    </p>
                                    <p className="text-[var(--text-secondary)] text-xs">
                                        Logging in as{" "}
                                        <strong>{username}</strong>
                                    </p>
                                </div>
                                <div>
                                    <label
                                        htmlFor="twoFactorToken"
                                        className="block text-sm font-medium text-[var(--text-primary)] mb-1.5"
                                    >
                                        {useRecoveryCode
                                            ? "Recovery Code"
                                            : "Authentication Code"}
                                    </label>
                                    <input
                                        id="twoFactorToken"
                                        type="text"
                                        value={twoFactorToken}
                                        onChange={(e) => {
                                            if (useRecoveryCode) {
                                                // Recovery code: 8 hex characters
                                                setTwoFactorToken(
                                                    e.target.value
                                                        .replace(
                                                            /[^A-Fa-f0-9]/g,
                                                            ""
                                                        )
                                                        .slice(0, 8)
                                                        .toUpperCase()
                                                );
                                            } else {
                                                // TOTP: 6 digits
                                                setTwoFactorToken(
                                                    e.target.value
                                                        .replace(/\D/g, "")
                                                        .slice(0, 6)
                                                );
                                            }
                                        }}
                                        placeholder={
                                            useRecoveryCode
                                                ? "ABCD1234"
                                                : "000000"
                                        }
                                        maxLength={useRecoveryCode ? 8 : 6}
                                        required
                                        autoFocus
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        className="w-full px-4 py-2.5 bg-white/5 border border-brand/30 rounded-lg text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent transition-all duration-200  text-center text-xl tracking-[0.5em]"
                                    />
                                    <p className="text-xs text-[var(--text-secondary)] mt-2">
                                        {useRecoveryCode
                                            ? "Enter your 8-character recovery code"
                                            : "Enter the 6-digit code from your authenticator app"}
                                    </p>
                                </div>

                                <div className="flex items-center justify-center">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setUseRecoveryCode(
                                                !useRecoveryCode
                                            );
                                            setTwoFactorToken("");
                                            setError("");
                                        }}
                                        className="text-xs text-brand hover:text-brand-light transition-colors underline"
                                    >
                                        {useRecoveryCode
                                            ? "Use authenticator app instead"
                                            : "Use recovery code instead"}
                                    </button>
                                </div>
                            </div>
                        )}

                        <Button
                            variant="primary"
                            size="lg"
                            type="submit"
                            isLoading={isLoading}
                            className="w-full"
                        >
                            {isLoading ? "Signing in..." : "Sign In"}
                        </Button>

                        {requires2FA && (
                            <button
                                type="button"
                                onClick={() => {
                                    setRequires2FA(false);
                                    setTwoFactorToken("");
                                    setUseRecoveryCode(false);
                                    setError("");
                                }}
                                className="w-full text-xs text-[var(--text-secondary)] hover:text-white/80 transition-colors"
                            >
                                ← Back to login
                            </button>
                        )}
                    </form>
                </div>

                <p className="text-center text-[var(--text-muted)] text-sm mt-6" suppressHydrationWarning>
                    © {new Date().getFullYear()} Kima. Your music, your way.
                </p>
            </div>
        </AuthShell>
    );
}
