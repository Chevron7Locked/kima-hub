"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import Image from "next/image";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useFeatures } from "@/lib/features-context";
import { useAuth } from "@/lib/auth-context";

export default function OnboardingPage() {
    const router = useRouter();
    const { user, isLoading: authLoading } = useAuth();
    const {
        musicCNN,
        vibeEmbeddings,
        loading: featuresLoading,
    } = useFeatures();
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const hasCheckedSession = useRef(false);
    const showPasswordMismatch = error === "Passwords don't match";
    const showPasswordTooShort =
        error === "Password must be at least 6 characters";

    // Step 1: Account creation
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    // Use auth context state instead of duplicate API call
    useEffect(() => {
        // Wait for auth context to finish loading
        if (authLoading) return;

        // Only check once to prevent re-renders
        if (hasCheckedSession.current) return;
        hasCheckedSession.current = true;

        // If user exists and hasn't completed onboarding, skip to step 2
        if (user && !user.onboardingComplete) {
            setStep(2);
        }
        setInitialLoading(false);
    }, [authLoading, user]);

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
        setSuccess("");

        if (password !== confirmPassword) {
            setError("Passwords don't match");
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            return;
        }

        setLoading(true);
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
            // Check if user already exists
            if (message?.includes("already taken")) {
                setError(
                    "Username already taken. If this is you, please refresh and continue where you left off.",
                );
            } else {
                setError(message || "Failed to create account");
            }
        } finally {
            setLoading(false);
        }
    };

    const testConnection = async (
        type: "lidarr" | "audiobookshelf" | "soulseek",
    ) => {
        setError("");
        setSuccess("");
        setLoading(true);

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
            setSuccess(`${type} connected successfully!`);
        } catch (err: unknown) {
            const errorMessage =
                err instanceof Error ?
                    err.message
                :   `Failed to connect to ${type}`;
            setError(errorMessage);
        } finally {
            setLoading(false);
        }
    };

    const handleNextStep = async () => {
        setError("");
        setSuccess("");
        setLoading(true);

        try {
            if (step === 2) {
                // Save all integration configs
                await Promise.all([
                    api.post("/onboarding/lidarr", lidarr),
                    api.post("/onboarding/audiobookshelf", audiobookshelf),
                    api.post("/onboarding/soulseek", soulseek),
                ]);
                setStep(3);
            } else if (step === 3) {
                await api.post("/onboarding/complete");
                router.push("/sync");
            }
        } catch (err: unknown) {
            setError(
                err instanceof Error ?
                    err.message
                :   "Failed to save configuration",
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative overflow-hidden">
            {/* Dark background (matches login) */}
            <div className="absolute inset-0 bg-[#000]">
                <div className="absolute inset-0 bg-gradient-to-br from-[#fca200]/5 via-transparent to-transparent" />
            </div>

            {/* Show loading spinner while checking session */}
            {initialLoading ?
                <div className="relative z-10 min-h-screen flex items-center justify-center">
                    <div className="text-center">
                        <GradientSpinner size="lg" />
                        <p className="text-white/60 mt-4">Loading...</p>
                    </div>
                </div>
            :   <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
                    <div className="w-full max-w-4xl">
                        {/* Logo/Brand */}
                        <div className="text-center mb-8">
                            <div className="inline-flex items-center gap-4 mb-4">
                                <div className="relative">
                                    <div className="absolute inset-0 bg-white/10 blur-xl rounded-full" />
                                    <Image
                                        src="/assets/images/kima.webp"
                                        alt="Kima"
                                        width={48}
                                        height={48}
                                        className="relative z-10 drop-shadow-2xl"
                                    />
                                </div>
                                <h1 className="text-4xl font-bold bg-gradient-to-r from-white via-white to-gray-200 bg-clip-text text-transparent drop-shadow-2xl">
                                    Kima Hub
                                </h1>
                            </div>
                            <p className="text-white/60 text-lg">
                                Welcome to your personal music streaming
                                platform
                            </p>
                        </div>

                        {/* Progress Steps */}
                        <div className="flex items-center justify-center gap-3 mb-8">
                            {[
                                { num: 1, label: "Account" },
                                { num: 2, label: "Integrations" },
                                { num: 3, label: "Enrichment" },
                            ].map((s, idx) => (
                                <div key={s.num} className="flex items-center">
                                    <div className="flex flex-col items-center">
                                        <div
                                            className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm transition-all ${
                                                s.num === step ?
                                                    "bg-[#fca200] text-black shadow-lg shadow-[#fca200]/20 scale-110"
                                                : s.num < step ?
                                                    "bg-white/5 text-white/80 border border-white/10"
                                                :   "bg-white/5 text-white/40 border border-white/10"
                                            }`}
                                        >
                                            {s.num}
                                        </div>
                                        <span
                                            className={`text-xs mt-2 transition-all ${
                                                s.num === step ?
                                                    "text-brand font-medium"
                                                :   "text-white/40"
                                            }`}
                                        >
                                            {s.label}
                                        </span>
                                    </div>
                                    {idx < 2 && (
                                        <div
                                            className={`w-16 h-0.5 mx-4 mb-6 transition-all ${
                                                s.num < step ?
                                                    "bg-[#fca200]/25"
                                                :   "bg-white/10"
                                            }`}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Main Content Card */}
                        <div className="bg-[#111]/90 rounded-lg border border-white/10 shadow-xl  overflow-hidden">
                            <div className="p-6 md:p-8">
                                {step === 1 && (
                                    <div className="space-y-6">
                                        <div>
                                            <h2 className="text-2xl font-bold text-white mb-1">
                                                Create Your Account
                                            </h2>
                                            <p className="text-white/60">
                                                Let&apos;s get you set up with
                                                your personal music library
                                            </p>
                                        </div>

                                        <form
                                            onSubmit={handleRegister}
                                            className="space-y-4 mt-8"
                                        >
                                            <div>
                                                <label className="block text-sm font-medium text-white/90 mb-1.5">
                                                    Username
                                                </label>
                                                <input
                                                    type="text"
                                                    value={username}
                                                    onChange={(e) =>
                                                        setUsername(
                                                            e.target.value,
                                                        )
                                                    }
                                                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                                                    placeholder="Choose a username"
                                                    required
                                                    minLength={3}
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-white/90 mb-1.5">
                                                    Password
                                                </label>
                                                <input
                                                    type="password"
                                                    value={password}
                                                    onChange={(e) =>
                                                        setPassword(
                                                            e.target.value,
                                                        )
                                                    }
                                                    className={`w-full px-4 py-3 bg-white/5 border rounded-lg text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all  ${
                                                        showPasswordTooShort ?
                                                            "border-red-500/50"
                                                        :   "border-white/10"
                                                    }`}
                                                    placeholder="At least 6 characters"
                                                    required
                                                    minLength={6}
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-white/90 mb-1.5">
                                                    Confirm Password
                                                </label>
                                                <input
                                                    type="password"
                                                    value={confirmPassword}
                                                    onChange={(e) =>
                                                        setConfirmPassword(
                                                            e.target.value,
                                                        )
                                                    }
                                                    className={`w-full px-4 py-3 bg-white/5 border rounded-lg text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all  ${
                                                        showPasswordMismatch ?
                                                            "border-red-500/50"
                                                        :   "border-white/10"
                                                    }`}
                                                    placeholder="Confirm your password"
                                                    required
                                                />
                                            </div>

                                            {error && (
                                                <div className="bg-red-500/10  border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
                                                    {error}
                                                </div>
                                            )}

                                            <button
                                                type="submit"
                                                disabled={loading}
                                                className="w-full py-3.5 bg-[#fca200] text-black font-bold rounded-lg hover:bg-[#e69200] transition-all disabled:opacity-50 disabled:cursor-not-allowed relative group overflow-hidden mt-8 focus:outline-none focus:ring-2 focus:ring-brand/30"
                                            >
                                                <span className="relative z-10 flex items-center justify-center gap-2">
                                                    {loading ?
                                                        <>
                                                            <GradientSpinner size="sm" />
                                                            Creating Account...
                                                        </>
                                                    :   "Continue"}
                                                </span>
                                            </button>
                                        </form>
                                    </div>
                                )}

                                {step === 2 && (
                                    <div className="space-y-6">
                                        <div>
                                            <h2 className="text-2xl font-bold text-white mb-1">
                                                Connect Your Services
                                            </h2>
                                            <p className="text-white/60">
                                                Optional integrations to enhance
                                                your music library
                                            </p>
                                        </div>

                                        <div className="space-y-4 mt-8">
                                            {/* Lidarr */}
                                            <IntegrationCard
                                                title="Lidarr"
                                                description="Automatic music library management"
                                                localPort="localhost:8686"
                                                icon={
                                                    <svg
                                                        className="w-6 h-6"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                    >
                                                        <path
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            strokeWidth={2}
                                                            d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                                                        />
                                                    </svg>
                                                }
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
                                                loading={loading}
                                            />

                                            {/* Audiobookshelf */}
                                            <IntegrationCard
                                                title="Audiobookshelf"
                                                description="Audiobook library management"
                                                localPort="localhost:13378"
                                                icon={
                                                    <svg
                                                        className="w-6 h-6"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                    >
                                                        <path
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            strokeWidth={2}
                                                            d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                                                        />
                                                    </svg>
                                                }
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
                                                loading={loading}
                                            />

                                            {/* Soulseek */}
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
                                                onUsernameChange={(username) =>
                                                    setSoulseek({
                                                        ...soulseek,
                                                        username,
                                                    })
                                                }
                                                onPasswordChange={(password) =>
                                                    setSoulseek({
                                                        ...soulseek,
                                                        password,
                                                    })
                                                }
                                                onTest={() =>
                                                    testConnection("soulseek")
                                                }
                                                loading={loading}
                                            />
                                        </div>

                                        {success && (
                                            <div className="flex items-center gap-2 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                                                <p className="text-sm text-green-500">
                                                    {success}
                                                </p>
                                            </div>
                                        )}

                                        {error && (
                                            <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                                                <p className="text-sm text-red-500">
                                                    {error}
                                                </p>
                                            </div>
                                        )}

                                        <div className="flex gap-3 mt-8">
                                            <button
                                                onClick={() => setStep(3)}
                                                onKeyDown={(e) =>
                                                    e.key === "Enter" &&
                                                    setStep(3)
                                                }
                                                tabIndex={0}
                                                className="flex-1 bg-white/5 border border-white/10 text-white/70 font-medium py-3.5 rounded-lg hover:bg-white/10 transition-all focus:outline-none focus:ring-2 focus:ring-brand/30"
                                            >
                                                Skip for Now
                                            </button>
                                            <button
                                                onClick={handleNextStep}
                                                onKeyDown={(e) =>
                                                    e.key === "Enter" &&
                                                    !loading &&
                                                    handleNextStep()
                                                }
                                                disabled={loading}
                                                tabIndex={0}
                                                className="flex-1 py-3.5 bg-[#fca200] text-black font-bold rounded-lg hover:bg-[#e69200] transition-all disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/30"
                                            >
                                                {loading ?
                                                    "Saving..."
                                                :   "Continue"}
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {step === 3 && (
                                    <div className="space-y-6">
                                        <div>
                                            <h2 className="text-2xl font-bold text-white mb-1">
                                                Analysis Features
                                            </h2>
                                            <p className="text-white/60">
                                                Advanced audio analysis
                                                capabilities detected
                                            </p>
                                        </div>

                                        <div className="bg-[#0f0f0f] border border-white/10 rounded-lg p-6 mt-8">
                                            <h3 className="text-lg font-semibold text-white mb-4">
                                                Detected Analysis Features
                                            </h3>

                                            {featuresLoading ?
                                                <div className="flex items-center gap-3 text-gray-400">
                                                    <GradientSpinner size="sm" />
                                                    <span>
                                                        Detecting available
                                                        features...
                                                    </span>
                                                </div>
                                            :   <div className="space-y-4">
                                                    <div
                                                        className={`p-4 rounded-lg border ${musicCNN ? "bg-green-500/5 border-green-500/20" : "bg-white/5 border-white/10"}`}
                                                    >
                                                        <div className="flex items-center gap-3 mb-2">
                                                            <span
                                                                className={
                                                                    musicCNN ?
                                                                        "text-green-400"
                                                                    :   "text-gray-500"
                                                                }
                                                            >
                                                                {musicCNN ?
                                                                    "\u2713"
                                                                :   "\u2014"}
                                                            </span>
                                                            <span
                                                                className={`font-medium ${musicCNN ? "text-white" : "text-gray-500"}`}
                                                            >
                                                                MusicCNN Audio
                                                                Analysis
                                                            </span>
                                                        </div>
                                                        <p className="text-sm text-white/50 ml-7">
                                                            Extracts BPM,
                                                            musical key, mood,
                                                            energy,
                                                            danceability, and
                                                            other audio features
                                                            using neural
                                                            networks trained on
                                                            music.
                                                        </p>
                                                    </div>
                                                    <div
                                                        className={`p-4 rounded-lg border ${vibeEmbeddings ? "bg-green-500/5 border-green-500/20" : "bg-white/5 border-white/10"}`}
                                                    >
                                                        <div className="flex items-center gap-3 mb-2">
                                                            <span
                                                                className={
                                                                    (
                                                                        vibeEmbeddings
                                                                    ) ?
                                                                        "text-green-400"
                                                                    :   "text-gray-500"
                                                                }
                                                            >
                                                                {(
                                                                    vibeEmbeddings
                                                                ) ?
                                                                    "\u2713"
                                                                :   "\u2014"}
                                                            </span>
                                                            <span
                                                                className={`font-medium ${vibeEmbeddings ? "text-white" : "text-gray-500"}`}
                                                            >
                                                                CLAP Vibe
                                                                Embeddings
                                                            </span>
                                                        </div>
                                                        <p className="text-sm text-white/50 ml-7">
                                                            Creates audio
                                                            fingerprints that
                                                            capture the overall
                                                            &quot;vibe&quot; of
                                                            each track, enabling
                                                            &quot;find similar
                                                            tracks&quot;
                                                            functionality.
                                                        </p>
                                                    </div>
                                                </div>
                                            }

                                            <div className="mt-6 pt-4 border-t border-white/10">
                                                <p className="text-sm text-gray-400">
                                                    {(
                                                        musicCNN ||
                                                        vibeEmbeddings
                                                    ) ?
                                                        <>
                                                            These analyzers run
                                                            in the background
                                                            and use ~3-4GB RAM
                                                            combined. To disable
                                                            them and save
                                                            resources, copy{" "}
                                                            <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs">
                                                                docker-compose.override.yml.lite
                                                            </code>{" "}
                                                            to{" "}
                                                            <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs">
                                                                docker-compose.override.yml
                                                            </code>{" "}
                                                            and restart.
                                                        </>
                                                    :   <>
                                                            Running in lite
                                                            mode. To enable
                                                            analyzers, remove{" "}
                                                            <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs">
                                                                docker-compose.override.yml
                                                            </code>{" "}
                                                            and restart with{" "}
                                                            <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs">
                                                                docker compose
                                                                up -d
                                                            </code>
                                                            .
                                                        </>
                                                    }
                                                </p>
                                            </div>
                                        </div>

                                        <div className="bg-[#0f0f0f] border border-white/10 rounded-lg p-6">
                                            <div className="flex items-start gap-4">
                                                <div className="w-12 h-12 bg-[#fca200]/10 border border-[#fca200]/20 rounded-lg flex items-center justify-center flex-shrink-0">
                                                    <svg
                                                        className="w-6 h-6 text-[#fca200]"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                    >
                                                        <path
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            strokeWidth={2}
                                                            d="M13 10V3L4 14h7v7l9-11h-7z"
                                                        />
                                                    </svg>
                                                </div>
                                                <div>
                                                    <h3 className="text-lg font-bold text-white mb-2">
                                                        Artist Enrichment
                                                    </h3>
                                                    <p className="text-white/60 text-sm leading-relaxed">
                                                        Enrichment automatically
                                                        fetches additional
                                                        metadata like artist
                                                        bios, high-quality
                                                        images, genres, and
                                                        relationships from
                                                        external sources. This
                                                        powers smart features
                                                        and provides a richer
                                                        listening experience.
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        {error && (
                                            <div className="flex items-center gap-2 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                                                <p className="text-red-500 text-sm">
                                                    {error}
                                                </p>
                                            </div>
                                        )}

                                        <div className="flex gap-3 mt-8">
                                            <button
                                                onClick={handleNextStep}
                                                onKeyDown={(e) =>
                                                    e.key === "Enter" &&
                                                    !loading &&
                                                    handleNextStep()
                                                }
                                                disabled={loading}
                                                className="w-full py-3.5 bg-[#fca200] text-black font-bold rounded-lg hover:bg-[#e69200] transition-all duration-200 disabled:opacity-50 disabled:hover:scale-100 relative group overflow-hidden focus:outline-none focus:ring-2 focus:ring-brand/30"
                                            >
                                                <span className="relative z-10 flex items-center justify-center gap-2">
                                                    {loading ?
                                                        <>
                                                            <GradientSpinner size="sm" />
                                                            Finishing Setup...
                                                        </>
                                                    :   "Complete Setup"}
                                                </span>
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Footer */}
                        <p className="text-center text-white/40 text-sm mt-6">
                            © 2025 Kima. Your music, your way.
                        </p>
                    </div>
                </div>
            }
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
    apiKey?: string;
    username?: string;
    password?: string;
    onUrlChange: (url: string) => void;
    onApiKeyChange?: (apiKey: string) => void;
    onUsernameChange?: (username: string) => void;
    onPasswordChange?: (password: string) => void;
    onTest: () => void;
    loading: boolean;
    useSoulseekCreds?: boolean;
}

function IntegrationCard({
    title,
    description,
    localPort,
    icon,
    enabled,
    onToggle,
    url,
    apiKey,
    username,
    password,
    onUrlChange,
    onApiKeyChange,
    onUsernameChange,
    onPasswordChange,
    onTest,
    loading,
    useSoulseekCreds = false,
}: IntegrationCardProps) {
    return (
        <div
            className={`border rounded-lg transition-all ${
                enabled ?
                    "bg-[#0f0f0f] border-brand/25"
                :   "bg-white/5 border-white/10"
            }`}
        >
            <div className="p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                                enabled ?
                                    "bg-[#fca200]/10 border border-[#fca200]/20 text-[#fca200]"
                                :   "bg-white/5 border border-white/10 text-white/40"
                            }`}
                        >
                            {icon}
                        </div>
                        <div>
                            <h3 className="text-white font-bold">{title}</h3>
                            <p className="text-sm text-white/50">
                                {description}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onToggle}
                        onKeyDown={(e) => e.key === "Enter" && onToggle()}
                        tabIndex={0}
                        className={`relative w-11 h-6 rounded-lg transition-all ${
                            enabled ? "bg-[#fca200]" : "bg-white/20"
                        } focus:outline-none focus:ring-2 focus:ring-brand/30`}
                    >
                        <div
                            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-[#fca200] rounded-lg transition-all shadow-lg ${
                                enabled ? "translate-x-5" : ""
                            }`}
                        />
                    </button>
                </div>

                {enabled && (
                    <div className="space-y-3 mt-4 pt-4 border-t border-white/10">
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => onUrlChange(e.target.value)}
                            placeholder={`Server URL (e.g., http://${
                                localPort || "localhost:PORT"
                            })`}
                            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                        />
                        {useSoulseekCreds ?
                            <>
                                <input
                                    type="text"
                                    value={username || ""}
                                    onChange={(e) =>
                                        onUsernameChange?.(e.target.value)
                                    }
                                    placeholder="Soulseek Username"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                                />
                                <input
                                    type="password"
                                    value={password || ""}
                                    onChange={(e) =>
                                        onPasswordChange?.(e.target.value)
                                    }
                                    placeholder="Soulseek Password"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                                />
                                <p className="text-xs text-white/50 mt-2">
                                    These are your Soulseek network credentials,
                                    not your Slskd login
                                </p>
                            </>
                        :   <input
                                type="password"
                                value={apiKey || ""}
                                onChange={(e) =>
                                    onApiKeyChange?.(e.target.value)
                                }
                                placeholder="API Key"
                                className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                            />
                        }
                        <button
                            onClick={onTest}
                            onKeyDown={(e) =>
                                e.key === "Enter" &&
                                !loading &&
                                !e.defaultPrevented &&
                                onTest()
                            }
                            disabled={
                                loading ||
                                !url ||
                                (!useSoulseekCreds ? !apiKey : (
                                    !username || !password
                                ))
                            }
                            tabIndex={0}
                            className="w-full bg-white/10 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-white/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/30"
                        >
                            Test Connection
                        </button>
                    </div>
                )}
            </div>
        </div>
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
    loading: boolean;
}

function SoulseekCard({
    enabled,
    onToggle,
    username,
    password,
    onUsernameChange,
    onPasswordChange,
    onTest,
    loading,
}: SoulseekCardProps) {
    return (
        <div
            className={`border rounded-lg transition-all ${
                enabled ?
                    "bg-[#0f0f0f] border-brand/25"
                :   "bg-white/5 border-white/10"
            }`}
        >
            <div className="p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                                enabled ?
                                    "bg-[#fca200]/10 border border-[#fca200]/20 text-[#fca200]"
                                :   "bg-white/5 border border-white/10 text-white/40"
                            }`}
                        >
                            <svg
                                className="w-6 h-6"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                                />
                            </svg>
                        </div>
                        <div>
                            <h3 className="text-white font-bold">Soulseek</h3>
                            <p className="text-sm text-white/50">
                                Peer-to-peer music discovery
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onToggle}
                        onKeyDown={(e) => e.key === "Enter" && onToggle()}
                        tabIndex={0}
                        className={`relative w-11 h-6 rounded-lg transition-all ${
                            enabled ? "bg-[#fca200]" : "bg-white/20"
                        } focus:outline-none focus:ring-2 focus:ring-brand/30`}
                    >
                        <div
                            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-[#fca200] rounded-lg transition-all shadow-lg ${
                                enabled ? "translate-x-5" : ""
                            }`}
                        />
                    </button>
                </div>

                {enabled && (
                    <div className="space-y-3 mt-4 pt-4 border-t border-white/10">
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => onUsernameChange(e.target.value)}
                            placeholder="Soulseek Username"
                            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                        />
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => onPasswordChange(e.target.value)}
                            placeholder="Soulseek Password"
                            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all "
                        />
                        <p className="text-xs text-white/50">
                            Create an account at{" "}
                            <a
                                href="https://www.slsknet.org/news/node/1"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#fca200] hover:underline"
                            >
                                slsknet.org
                            </a>
                        </p>
                        <button
                            onClick={onTest}
                            onKeyDown={(e) =>
                                e.key === "Enter" &&
                                !loading &&
                                username &&
                                password &&
                                onTest()
                            }
                            disabled={loading || !username || !password}
                            tabIndex={0}
                            className="w-full bg-white/10 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-white/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/30"
                        >
                            Test Connection
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
