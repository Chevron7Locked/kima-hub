"use client";

import { useState } from "react";
import { BookOpen, Music, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/Button";
import { KimaMark } from "@/components/ui/KimaMark";

type IntegrationKey = "lidarr" | "audiobookshelf" | "soulseek";
type IntegrationResult = { ok: boolean; message: string };

export default function OnboardingPage() {
    const router = useRouter();
    const { user, isLoading: authLoading } = useAuth();
    const [step, setStep] = useState(1);
    // Separate submitting state: account creation + complete/skip
    const [submitting, setSubmitting] = useState(false);
    // Per-integration test loading: which integration is mid-test (null = none)
    const [testingIntegration, setTestingIntegration] =
        useState<IntegrationKey | null>(null);
    // Per-integration results: each key holds its own ok/message, not clobbered
    const [integrationResults, setIntegrationResults] = useState<
        Partial<Record<IntegrationKey, IntegrationResult>>
    >({});
    const [initialLoading, setInitialLoading] = useState(true);
    const [error, setError] = useState("");
    const showPasswordMismatch = error === "Passwords don't match";
    const showPasswordTooShort =
        error === "Password must be at least 6 characters";

    // Step 1: Account creation
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    // Only check the session once, as soon as auth has settled
    if (!authLoading && initialLoading) {
        setInitialLoading(false);
        // If user exists and hasn't completed onboarding, skip to step 2
        if (user && !user.onboardingComplete) {
            setStep(2);
        }
    }

    // Step 2: Integrations
    const [lidarr, setLidarr] = useState({
        url: "",
        apiKey: "",
        enabled: false,
    });
    const [audiobookshelf, setAudiobookshelf] = useState({
        url: "",
        apiKey: "",
        enabled: false,
    });
    const [soulseek, setSoulseek] = useState({
        username: "",
        password: "",
        enabled: false,
    });

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError("Passwords don't match");
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            return;
        }

        setSubmitting(true);
        try {
            try {
                const healthRes = await fetch("/api/health", { method: "GET" });
                if (!healthRes.ok) throw new Error("not ready");
            } catch {
                setError("Cannot reach the server. Check that Kima is fully started and try again.");
                return;
            }
            const response = await api.post<{
                token: string;
                user: { id: string; username: string };
            }>("/onboarding/register", { username, password });
            // Store the JWT token for subsequent API calls
            if (response.token) {
                api.setToken(response.token);
            }
            setStep(2);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (message?.includes("already taken")) {
                // Usually a refresh/retry race: the account was created but the
                // token never persisted client-side. Rather than dead-end on a
                // "refresh" instruction that can't recover the session, try
                // logging in with the same credentials and continue.
                try {
                    const loggedInUser = await api.login(username, password);
                    if (loggedInUser.requires2FA) {
                        router.push("/login");
                        return;
                    }
                    if (loggedInUser.onboardingComplete) {
                        router.push("/");
                        return;
                    }
                    setStep(2);
                    return;
                } catch {
                    setError(
                        "That username already exists and the password didn't match. If it's your account, sign in instead.",
                    );
                }
            } else {
                setError(message || "Failed to create account");
            }
        } finally {
            setSubmitting(false);
        }
    };

    const testConnection = async (type: IntegrationKey) => {
        setTestingIntegration(type);
        // Clear only this integration's result before retesting
        setIntegrationResults((prev) => {
            const next = { ...prev };
            delete next[type];
            return next;
        });

        try {
            if (type === "lidarr") {
                if (!lidarr.url || !lidarr.apiKey) {
                    throw new Error("URL and API key are required");
                }
                await api.post("/system-settings/test-lidarr", {
                    url: lidarr.url,
                    apiKey: lidarr.apiKey,
                });
            } else if (type === "audiobookshelf") {
                if (!audiobookshelf.url || !audiobookshelf.apiKey) {
                    throw new Error("URL and API key are required");
                }
                await api.post("/system-settings/test-audiobookshelf", {
                    url: audiobookshelf.url,
                    apiKey: audiobookshelf.apiKey,
                });
            } else if (type === "soulseek") {
                if (!soulseek.username || !soulseek.password) {
                    throw new Error("Username and password are required");
                }
                await api.post("/system-settings/test-soulseek", {
                    username: soulseek.username,
                    password: soulseek.password,
                });
            }
            setIntegrationResults((prev) => ({
                ...prev,
                [type]: { ok: true, message: `${type} connected successfully!` },
            }));
        } catch (err: unknown) {
            const errorMessage =
                err instanceof Error ?
                    err.message
                :   `Failed to connect to ${type}`;
            setIntegrationResults((prev) => ({
                ...prev,
                [type]: { ok: false, message: errorMessage },
            }));
        } finally {
            setTestingIntegration(null);
        }
    };

    const handleNextStep = async () => {
        setError("");
        setSubmitting(true);

        try {
            if (step === 2) {
                // Save all integration configs and complete onboarding
                // Only send field values for enabled integrations; disabled ones get clean payloads
                await Promise.all([
                    api.post("/onboarding/lidarr", lidarr.enabled ? lidarr : { url: "", apiKey: "", enabled: false }),
                    api.post("/onboarding/audiobookshelf", audiobookshelf.enabled ? audiobookshelf : { url: "", apiKey: "", enabled: false }),
                    api.post("/onboarding/soulseek", soulseek.enabled ? soulseek : { username: "", password: "", enabled: false }),
                ]);
                await api.post("/onboarding/complete");
                router.push("/sync");
            }
        } catch (err: unknown) {
            setError(
                err instanceof Error ?
                    err.message
                : "Failed to save configuration",
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen relative overflow-hidden">
            <div className="absolute inset-0 bg-[#000]">
                <div className="absolute inset-0 bg-gradient-to-br from-brand/5 via-transparent to-transparent" />
            </div>

            {initialLoading ?
                <div className="relative z-(--z-raised) min-h-screen flex items-center justify-center">
                    <div className="text-center">
                        <GradientSpinner size="lg" />
                        <p className="text-[var(--text-secondary)] mt-4">Loading...</p>
                    </div>
                </div>
            :   <div className="relative z-(--z-raised) min-h-screen flex items-center justify-center p-6">
                    <div className="w-full max-w-4xl">
                        <div className="text-center mb-8">
                            <div className="inline-flex items-center gap-4 mb-4">
                                <div className="relative">
                                    <div className="absolute inset-0 bg-white/10 blur-xl rounded-full" />
                                    <KimaMark size={48} className="relative z-(--z-raised)" />
                                </div>
                                <h1 className="text-4xl font-bold text-white">
                                    Kima Hub
                                </h1>
                            </div>
                            <p className="text-[var(--text-secondary)] text-lg">
                                Welcome to your personal music streaming
                                platform
                            </p>
                        </div>

                        <div className="flex items-center justify-center gap-3 mb-8">
                            {[
                                { num: 1, label: "Account" },
                                { num: 2, label: "Integrations" },
                            ].map((s, idx) => (
                                <div key={s.num} className="flex items-center">
                                    <div className="flex flex-col items-center">
                                        <div
                                            className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm transition-all ${
                                                s.num === step ?
                                                "bg-brand text-black scale-110"
                                                : s.num < step ?
                                                "bg-white/5 text-[var(--text-primary)] border border-white/10"
                                                : "bg-white/5 text-[var(--text-muted)] border border-white/10"
                                            }`}
                                        >
                                            {s.num}
                                        </div>
                                        <span
                                            className={`text-xs mt-2 transition-all ${
                                                s.num === step ?
                                                "text-brand font-medium"
                                                : "text-[var(--text-muted)]"
                                            }`}
                                        >
                                            {s.label}
                                        </span>
                                    </div>
                                    {idx < 1 && (
                                        <div
                                            className={`w-16 h-0.5 mx-4 mb-6 transition-all ${
                                                s.num < step ?
                                                "bg-brand/25"
                                                : "bg-white/10"
                                            }`}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>

                        <div className="bg-[#111]/90 rounded-lg border border-white/10 overflow-hidden">
                            <div className="p-6 md:p-8">
                                {step === 1 && (
                                    <div className="space-y-6">
                                        <div>
                                            <h2 className="text-2xl font-bold text-white mb-1">
                                                Create Your Admin Account
                                            </h2>
                                            <p className="text-[var(--text-secondary)]">
                                                This is the owner account for your Kima server. You&apos;ll manage users, integrations, and settings from here.
                                            </p>
                                        </div>

                                        <form
                                            onSubmit={handleRegister}
                                            className="space-y-4 mt-8"
                                        >
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
                                                        setUsername(
                                                            e.target.value,
                                                        )
                                                    }
                                                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all"
                                                    placeholder="Choose a username"
                                                    required
                                                    minLength={3}
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
                                                        setPassword(
                                                            e.target.value,
                                                        )
                                                    }
                                                    className={`w-full px-4 py-3 bg-white/5 border rounded-lg text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all ${
                                                        showPasswordTooShort ?
                                                        "border-danger/50"
                                                        : "border-white/10"
                                                    }`}
                                                    placeholder="At least 6 characters"
                                                    required
                                                    minLength={6}
                                                />
                                            </div>

                                            <div>
                                                <label
                                                    htmlFor="confirmPassword"
                                                    className="block text-sm font-medium text-[var(--text-primary)] mb-1.5"
                                                >
                                                    Confirm Password
                                                </label>
                                                <input
                                                    id="confirmPassword"
                                                    type="password"
                                                    value={confirmPassword}
                                                    onChange={(e) =>
                                                        setConfirmPassword(
                                                            e.target.value,
                                                        )
                                                    }
                                                    className={`w-full px-4 py-3 bg-white/5 border rounded-lg text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all ${
                                                        showPasswordMismatch ?
                                                        "border-danger/50"
                                                        : "border-white/10"
                                                    }`}
                                                    placeholder="Confirm your password"
                                                    required
                                                />
                                            </div>

                                            {error && (
                                                <div className="bg-danger/10 border border-danger/30 rounded-lg p-4 text-sm text-danger-light">
                                                    {error}
                                                </div>
                                            )}

                                            <Button
                                                variant="primary"
                                                size="lg"
                                                type="submit"
                                                isLoading={submitting}
                                                className="w-full mt-8"
                                            >
                                                {submitting ? "Creating Account..." : "Continue"}
                                            </Button>
                                        </form>
                                    </div>
                                )}

                                {step === 2 && (
                                    <div className="space-y-6">
                                        <div>
                                            <h2 className="text-2xl font-bold text-white mb-1">
                                                Connect Your Services
                                            </h2>
                                            <p className="text-[var(--text-secondary)]">
                                                All integrations are optional -- you can enable or change them later in Settings.
                                            </p>
                                        </div>

                                        <div className="space-y-4 mt-8">
                                            <IntegrationCard
                                                title="Lidarr"
                                                description="Automatically find and download albums missing from your library."
                                                localPort="localhost:8686"
                                                icon={<Music className="w-6 h-6" />}
                                                enabled={lidarr.enabled}
                                                onToggle={() =>
                                                    setLidarr({
                                                        ...lidarr,
                                                        enabled:
                                                            !lidarr.enabled,
                                                    })
                                                }
                                                url={lidarr.url}
                                                apiKey={lidarr.apiKey}
                                                onUrlChange={(url) =>
                                                    setLidarr({
                                                        ...lidarr,
                                                        url,
                                                    })
                                                }
                                                onApiKeyChange={(apiKey) =>
                                                    setLidarr({
                                                        ...lidarr,
                                                        apiKey,
                                                    })
                                                }
                                                onTest={() =>
                                                    testConnection("lidarr")
                                                }
                                                testing={testingIntegration === "lidarr"}
                                                result={integrationResults["lidarr"]}
                                            />

                                            <IntegrationCard
                                                title="Audiobookshelf"
                                                description="Browse and stream your audiobook collection alongside your music."
                                                localPort="localhost:13378"
                                                icon={<BookOpen className="w-6 h-6" />}
                                                enabled={audiobookshelf.enabled}
                                                onToggle={() =>
                                                    setAudiobookshelf({
                                                        ...audiobookshelf,
                                                        enabled:
                                                            !audiobookshelf.enabled,
                                                    })
                                                }
                                                url={audiobookshelf.url}
                                                apiKey={audiobookshelf.apiKey}
                                                onUrlChange={(url) =>
                                                    setAudiobookshelf({
                                                        ...audiobookshelf,
                                                        url,
                                                    })
                                                }
                                                onApiKeyChange={(apiKey) =>
                                                    setAudiobookshelf({
                                                        ...audiobookshelf,
                                                        apiKey,
                                                    })
                                                }
                                                onTest={() =>
                                                    testConnection(
                                                        "audiobookshelf",
                                                    )
                                                }
                                                testing={testingIntegration === "audiobookshelf"}
                                                result={integrationResults["audiobookshelf"]}
                                            />

                                            <SoulseekCard
                                                enabled={soulseek.enabled}
                                                onToggle={() =>
                                                    setSoulseek({
                                                        ...soulseek,
                                                        enabled:
                                                            !soulseek.enabled,
                                                    })
                                                }
                                                username={soulseek.username}
                                                password={soulseek.password}
                                                onUsernameChange={(u) =>
                                                    setSoulseek({
                                                        ...soulseek,
                                                        username: u,
                                                    })
                                                }
                                                onPasswordChange={(p) =>
                                                    setSoulseek({
                                                        ...soulseek,
                                                        password: p,
                                                    })
                                                }
                                                onTest={() =>
                                                    testConnection("soulseek")
                                                }
                                                testing={testingIntegration === "soulseek"}
                                                result={integrationResults["soulseek"]}
                                            />
                                        </div>

                                        {error && (
                                            <div className="flex items-center gap-2 p-4 rounded-lg bg-danger/10 border border-danger/20">
                                                <p className="text-sm text-danger">
                                                    {error}
                                                </p>
                                            </div>
                                        )}

                                        <p className="text-sm text-[var(--text-muted)] border-t border-white/10 pt-4">
                                            After finishing, Kima will scan your music library and start enrichment in the background. This may take a few minutes for large collections.
                                        </p>

                                        <div className="flex gap-3">
                                            <Button
                                                variant="secondary"
                                                size="lg"
                                                onClick={async () => {
                                                    setSubmitting(true);
                                                    try {
                                                        await api.post("/onboarding/complete");
                                                        router.push("/sync");
                                                    } catch {
                                                        setError("Failed to complete setup");
                                                        setSubmitting(false);
                                                    }
                                                }}
                                                disabled={submitting}
                                                className="flex-1"
                                            >
                                                Finish without integrations
                                            </Button>
                                            <Button
                                                variant="primary"
                                                size="lg"
                                                onClick={handleNextStep}
                                                isLoading={submitting}
                                                className="flex-1"
                                            >
                                                {submitting ? "Saving..." : "Save & Finish"}
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <p className="text-center text-[var(--text-muted)] text-sm mt-6" suppressHydrationWarning>
                            &copy; {new Date().getFullYear()} Kima. Your music, your way.
                        </p>
                    </div>
                </div>
            }
        </div>
    );
}

const INPUT_CLASS =
    "w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all";

interface IntegrationShellProps {
    title: string;
    description: string;
    icon: React.ReactNode;
    enabled: boolean;
    onToggle: () => void;
    canTest: boolean;
    onTest: () => void;
    testing: boolean;
    result?: IntegrationResult;
    children: React.ReactNode;
}

function IntegrationShell({
    title,
    description,
    icon,
    enabled,
    onToggle,
    canTest,
    onTest,
    testing,
    result,
    children,
}: IntegrationShellProps) {
    return (
        <div
            className={`border rounded-lg transition-all ${
                enabled ?
                "bg-[var(--bg-secondary)] border-brand/25"
                : "bg-white/5 border-white/10"
            }`}
        >
            <div className="p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                                enabled ?
                                "bg-brand/10 border border-brand/20 text-brand"
                                : "bg-white/5 border border-white/10 text-[var(--text-muted)]"
                            }`}
                        >
                            {icon}
                        </div>
                        <div>
                            <h3 className="text-white font-bold">{title}</h3>
                            <p className="text-sm text-[var(--text-secondary)]">
                                {description}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onToggle}
                        aria-label={`${enabled ? "Disable" : "Enable"} ${title}`}
                        aria-pressed={enabled}
                        className={`relative w-11 h-6 rounded-lg transition-all ${
                            enabled ? "bg-brand" : "bg-white/20"
                        } focus:outline-none focus:ring-2 focus:ring-brand/30`}
                    >
                        <div
                            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-brand rounded-lg transition-all ${
                                enabled ? "translate-x-5" : ""
                            }`}
                        />
                    </button>
                </div>

                {enabled && (
                    <div className="space-y-3 mt-4 pt-4 border-t border-white/10">
                        {children}
                        {result && (
                            <p
                                className={`text-xs ${
                                    result.ok ?
                                    "text-success"
                                    : "text-danger-light"
                                }`}
                            >
                                {result.message}
                            </p>
                        )}
                        <Button
                            variant="secondary"
                            onClick={onTest}
                            disabled={!canTest}
                            isLoading={testing}
                            className="w-full"
                        >
                            {testing ? "Testing..." : "Test Connection"}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

interface IntegrationCardProps {
    title: string;
    description: string;
    localPort?: string;
    icon: React.ReactNode;
    enabled: boolean;
    onToggle: () => void;
    url: string;
    apiKey: string;
    onUrlChange: (url: string) => void;
    onApiKeyChange: (apiKey: string) => void;
    onTest: () => void;
    testing: boolean;
    result?: IntegrationResult;
}

function IntegrationCard({
    localPort,
    url,
    apiKey,
    onUrlChange,
    onApiKeyChange,
    ...shell
}: IntegrationCardProps) {
    return (
        <IntegrationShell {...shell} canTest={!shell.testing && !!url && !!apiKey}>
            <input
                type="url"
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                placeholder={`Server URL (e.g., http://${localPort || "localhost:PORT"})`}
                className={INPUT_CLASS}
            />
            <input
                type="password"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder="API Key"
                className={INPUT_CLASS}
            />
        </IntegrationShell>
    );
}

interface SoulseekCardProps {
    enabled: boolean;
    onToggle: () => void;
    username: string;
    password: string;
    onUsernameChange: (username: string) => void;
    onPasswordChange: (password: string) => void;
    onTest: () => void;
    testing: boolean;
    result?: IntegrationResult;
}

function SoulseekCard({
    username,
    password,
    onUsernameChange,
    onPasswordChange,
    ...shell
}: SoulseekCardProps) {
    return (
        <IntegrationShell
            {...shell}
            title="Soulseek"
            description="Peer-to-peer search to fill in tracks you don't own."
            icon={<Search className="w-6 h-6" />}
            canTest={!shell.testing && !!username && !!password}
        >
            <input
                type="text"
                value={username}
                onChange={(e) => onUsernameChange(e.target.value)}
                placeholder="Soulseek Username"
                className={INPUT_CLASS}
            />
            <input
                type="password"
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                placeholder="Soulseek Password"
                className={INPUT_CLASS}
            />
            <p className="text-xs text-[var(--text-secondary)]">
                Create an account at{" "}
                <a
                    href="https://www.slsknet.org/news/node/1"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand hover:underline"
                >
                    slsknet.org
                </a>
            </p>
        </IntegrationShell>
    );
}
