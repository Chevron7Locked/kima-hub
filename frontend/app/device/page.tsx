"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { QRCodeSVG } from "qrcode.react";
import { Card } from "@/components/ui/Card";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    Smartphone,
    RefreshCw,
    Check,
    Clock,
    Copy,
    Trash2,
    AlertCircle
} from "lucide-react";
import { cn } from "@/utils/cn";

interface DeviceLinkCode {
    code: string;
    expiresAt: string;
    expiresIn: number;
}

interface LinkedDevice {
    id: string;
    name: string;
    lastUsed: string;
    createdAt: string;
}

export default function DeviceLinkPage() {
    const router = useRouter();
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const { toast } = useToast();
    const [linkCode, setLinkCode] = useState<DeviceLinkCode | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [codeUsed, setCodeUsed] = useState(false);
    const [devices, setDevices] = useState<LinkedDevice[]>([]);
    const [isLoadingDevices, setIsLoadingDevices] = useState(true);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Redirect if not authenticated
    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, authLoading, router]);

    // Load linked devices
    const loadDevices = useCallback(async () => {
        try {
            const response = await api.request<LinkedDevice[]>("/device-link/devices");
            setDevices(response);
        } catch (err) {
            console.error("Failed to load devices:", err);
            toast.error("Failed to load linked devices");
        } finally {
            setIsLoadingDevices(false);
        }
    }, [toast]);

    useEffect(() => {
        if (isAuthenticated) {
            loadDevices();
        }
    }, [isAuthenticated, loadDevices]);

    // Generate a new link code
    const generateCode = async () => {
        setIsGenerating(true);
        setError(null);
        setCodeUsed(false);

        try {
            const response = await api.request<DeviceLinkCode>("/device-link/generate", {
                method: "POST",
            });
            setLinkCode(response);
            setTimeRemaining(response.expiresIn);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to generate code");
        } finally {
            setIsGenerating(false);
        }
    };

    // Countdown timer
    useEffect(() => {
        if (timeRemaining <= 0 || codeUsed) return;

        const timer = setInterval(() => {
            setTimeRemaining((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(timer);
    }, [timeRemaining, codeUsed]);

    // Poll for code usage
    useEffect(() => {
        if (!linkCode || timeRemaining <= 0 || codeUsed) return;

        const pollInterval = setInterval(async () => {
            try {
                const status = await api.request<{ status: string; deviceName?: string }>(
                    `/device-link/status/${linkCode.code}`
                );

                if (status.status === "used") {
                    setCodeUsed(true);
                    loadDevices(); // Refresh devices list
                }
            } catch (err) {
                console.error("Failed to check code status:", err);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [linkCode, timeRemaining, codeUsed, loadDevices]);

    // Copy code to clipboard
    const copyCode = () => {
        if (linkCode) {
            navigator.clipboard.writeText(linkCode.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    // Revoke a device
    const revokeDevice = async (deviceId: string) => {
        try {
            await api.request(`/device-link/devices/${deviceId}`, {
                method: "DELETE",
            });
            setDevices((prev) => prev.filter((d) => d.id !== deviceId));
        } catch (err) {
            console.error("Failed to revoke device:", err);
        }
    };

    // Format time remaining
    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    // Build QR code URL (contains code and server URL)
    const getQRValue = () => {
        if (!linkCode) return "";
        const serverUrl = typeof window !== "undefined" ? window.location.origin : "";
        return `kima://link?code=${linkCode.code}&server=${encodeURIComponent(serverUrl)}`;
    };

    if (authLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <div className="min-h-screen relative pb-24">
            {/* Header gradient */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-0 bg-gradient-to-b from-purple-500/10 via-transparent to-transparent" style={{ height: "50vh" }} />
            </div>

            <div className="relative max-w-4xl mx-auto px-6 md:px-8 py-8">
                {/* Title */}
                <div className="mb-8">
                    <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-2">
                        Link Mobile Device
                    </h1>
                    <p className="text-[var(--text-secondary)]">
                        Scan the QR code or enter the code in the Kima app to link your device
                    </p>
                </div>

                <div className="grid md:grid-cols-2 gap-8">
                    {/* QR Code Section */}
                    <Card className="p-6 bg-white/[0.03] border border-white/5">
                        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                            <Smartphone className="w-5 h-5" />
                            Device Link Code
                        </h2>

                        {error && (
                            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm flex items-center gap-2">
                                <AlertCircle className="w-4 h-4" />
                                {error}
                            </div>
                        )}

                        {!linkCode && !isGenerating && (
                            <div className="text-center py-8">
                                <p className="text-[var(--text-secondary)] mb-4">
                                    Generate a one-time code to link your mobile device
                                </p>
                                <button
                                    onClick={generateCode}
                                    className="px-6 py-3 bg-brand hover:bg-[#d4a000] text-black font-medium rounded-full transition-all hover:scale-105"
                                >
                                    Generate Code
                                </button>
                            </div>
                        )}

                        {isGenerating && (
                            <div className="flex items-center justify-center py-16">
                                <GradientSpinner size="md" />
                            </div>
                        )}

                        {linkCode && !isGenerating && (
                            <div className="text-center">
                                {codeUsed ? (
                                    <div className="py-8">
                                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                                            <Check className="w-8 h-8 text-green-400" />
                                        </div>
                                        <h3 className="text-xl font-bold text-white mb-2">
                                            Device Linked!
                                        </h3>
                                        <p className="text-[var(--text-secondary)] mb-4">
                                            Your device has been successfully connected
                                        </p>
                                        <button
                                            onClick={generateCode}
                                            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-all text-sm"
                                        >
                                            Link Another Device
                                        </button>
                                    </div>
                                ) : timeRemaining <= 0 ? (
                                    <div className="py-8">
                                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                                            <Clock className="w-8 h-8 text-red-400" />
                                        </div>
                                        <h3 className="text-xl font-bold text-white mb-2">
                                            Code Expired
                                        </h3>
                                        <p className="text-[var(--text-secondary)] mb-4">
                                            Generate a new code to continue
                                        </p>
                                        <button
                                            onClick={generateCode}
                                            className="px-4 py-2 bg-brand hover:bg-[#d4a000] text-black font-medium rounded-full transition-all"
                                        >
                                            <RefreshCw className="w-4 h-4 inline mr-2" />
                                            Generate New Code
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        {/* QR Code */}
                                        <div className="bg-white p-4 rounded-xl inline-block mb-4">
                                            <QRCodeSVG
                                                value={getQRValue()}
                                                size={180}
                                                level="M"
                                                includeMargin={false}
                                            />
                                        </div>

                                        {/* Code Display */}
                                        <div className="mb-4" aria-live="polite">
                                            <p className="text-[var(--text-secondary)] text-sm mb-2">
                                                Or enter this code manually:
                                            </p>
                                            <div className="flex items-center justify-center gap-2">
                                                <code className="text-3xl font-mono font-bold text-white tracking-widest bg-white/10 px-4 py-2 rounded-lg">
                                                    {linkCode.code}
                                                </code>
                                                <button
                                                    onClick={copyCode}
                                                    className={cn(
                                                        "p-2 min-h-[44px] min-w-[44px] rounded-lg transition-all flex items-center justify-center",
                                                        copied
                                                            ? "bg-green-500/20 text-green-400"
                                                            : "bg-white/10 hover:bg-white/20 text-[var(--text-secondary)]"
                                                    )}
                                                    aria-label={copied ? "Code copied" : "Copy code"}
                                                >
                                                    {copied ? (
                                                        <Check className="w-5 h-5" />
                                                    ) : (
                                                        <Copy className="w-5 h-5" />
                                                    )}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Timer */}
                                        <div className="flex items-center justify-center gap-2 text-[var(--text-secondary)]">
                                            <Clock className="w-4 h-4" />
                                            <span>
                                                Expires in {formatTime(timeRemaining)}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </Card>

                    {/* Linked Devices Section */}
                    <Card className="p-6 bg-white/[0.03] border border-white/5">
                        <h2 className="text-xl font-bold text-white mb-4">
                            Linked Devices
                        </h2>

                        {isLoadingDevices ? (
                            <div className="flex items-center justify-center py-8">
                                <GradientSpinner size="sm" />
                            </div>
                        ) : devices.length === 0 ? (
                            <div className="text-center py-8 text-[var(--text-secondary)]">
                                <Smartphone className="w-12 h-12 mx-auto mb-4 opacity-50" />
                                <p>No devices linked yet</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {devices.map((device) => (
                                    <div
                                        key={device.id}
                                        className="flex items-center justify-between p-3 bg-white/5 rounded-lg"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                                                <Smartphone className="w-5 h-5 text-purple-400" />
                                            </div>
                                            <div>
                                                <p className="text-white font-medium">
                                                    {device.name}
                                                </p>
                                                <p className="text-[var(--text-muted)] text-sm">
                                                    Last used:{" "}
                                                    {new Date(device.lastUsed).toLocaleDateString()}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => revokeDevice(device.id)}
                                            className="p-2 min-h-[44px] min-w-[44px] text-[var(--text-secondary)] hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all flex items-center justify-center"
                                            aria-label={`Revoke ${device.name}`}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>
                </div>

                {/* Instructions */}
                <Card className="mt-8 p-6 bg-white/[0.03] border border-white/5">
                    <h2 className="text-xl font-bold text-white mb-4">
                        How to Link Your Device
                    </h2>
                    <ol className="space-y-3 text-[var(--text-secondary)]">
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-brand)]/20 text-brand text-sm font-bold flex items-center justify-center">
                                1
                            </span>
                            <span>Open the Kima app on your mobile device</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-brand)]/20 text-brand text-sm font-bold flex items-center justify-center">
                                2
                            </span>
                            <span>Tap &quot;Scan QR Code&quot; or &quot;Enter Code&quot; on the login screen</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-brand)]/20 text-brand text-sm font-bold flex items-center justify-center">
                                3
                            </span>
                            <span>Scan the QR code above, or manually enter the 6-digit code</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-brand)]/20 text-brand text-sm font-bold flex items-center justify-center">
                                4
                            </span>
                            <span>Your device will be automatically logged in and linked to your account</span>
                        </li>
                    </ol>
                </Card>
            </div>
        </div>
    );
}

