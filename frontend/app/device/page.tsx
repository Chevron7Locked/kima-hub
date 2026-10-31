"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { QRCodeSVG } from "qrcode.react";
import { Card } from "@/components/ui/Card";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { formatTime } from "@/lib/format";
import {
    Smartphone,
    RefreshCw,
    Check,
    Clock,
    Copy,
    Trash2,
    AlertCircle
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/layout/PageHeader";
import { copyText } from "@/lib/clipboard";

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
    const [linkCode, setLinkCode] = useState<DeviceLinkCode | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [codeUsed, setCodeUsed] = useState(false);
    const [devices, setDevices] = useState<LinkedDevice[]>([]);
    const [isLoadingDevices, setIsLoadingDevices] = useState(true);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingRevoke, setPendingRevoke] = useState<LinkedDevice | null>(null);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, authLoading, router]);

    const loadDevices = useCallback(() => {
        return api
            .request<LinkedDevice[]>("/device-link/devices")
            .then(setDevices)
            .catch((err) => {
                console.error("Failed to load devices:", err);
                notify.error("Failed to load linked devices");
            })
            .finally(() => setIsLoadingDevices(false));
    }, []);

    useEffect(() => {
        if (isAuthenticated) {
            loadDevices();
        }
    }, [isAuthenticated, loadDevices]);

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

    const expired = timeRemaining <= 0;

    useEffect(() => {
        if (!linkCode || expired || codeUsed) return;

        const timer = setInterval(() => {
            setTimeRemaining((prev) => Math.max(prev - 1, 0));
        }, 1000);

        return () => clearInterval(timer);
    }, [linkCode, expired, codeUsed]);

    useEffect(() => {
        if (!linkCode || expired || codeUsed) return;

        const pollInterval = setInterval(async () => {
            try {
                const status = await api.request<{ status: string; deviceName?: string }>(
                    `/device-link/status/${linkCode.code}`
                );

                if (status.status === "used") {
                    setCodeUsed(true);
                    loadDevices();
                }
            } catch (err) {
                console.error("Failed to check code status:", err);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [linkCode, expired, codeUsed, loadDevices]);

    const copyCode = async () => {
        if (linkCode && (await copyText(linkCode.code))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const revokeDevice = async (device: LinkedDevice) => {
        try {
            await api.request(`/device-link/devices/${device.id}`, {
                method: "DELETE",
            });
            setDevices((prev) => prev.filter((d) => d.id !== device.id));
        } catch {
            notify.error("Couldn't unlink device", { message: `${device.name} is still linked. Try again.` });
        }
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
        <div className="min-h-screen pb-24">
            <PageHeader
                title="Link a device"
                description="Scan the QR code, or type the code into the app on your phone"
            />

            <div className="page-shell">
                <div className="max-w-4xl">

                    <div className="grid md:grid-cols-2 gap-8">
                        <Card className="p-6 bg-white/[0.03] border border-white/5">
                            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                                <Smartphone className="w-5 h-5" />
                                Device Link Code
                            </h2>

                            {error && (
                                <div className="mb-4 p-3 bg-danger/10 border border-danger/20 rounded-lg text-danger-light text-sm flex items-center gap-2">
                                    <AlertCircle className="w-4 h-4" />
                                    {error}
                                </div>
                            )}

                            {!linkCode && !isGenerating && (
                                <div className="text-center py-8">
                                    <p className="text-[var(--text-secondary)] mb-4">
                                        Generate a one-time code to link your mobile device
                                    </p>
                                    <Button
                                        variant="primary"
                                        onClick={generateCode}
                                    >
                                        Generate Code
                                    </Button>
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
                                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/20 flex items-center justify-center">
                                                <Check className="w-8 h-8 text-success" />
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
                                    ) : expired ? (
                                        <div className="py-8">
                                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-danger/20 flex items-center justify-center">
                                                <Clock className="w-8 h-8 text-danger-light" />
                                            </div>
                                            <h3 className="text-xl font-bold text-white mb-2">
                                                Code Expired
                                            </h3>
                                            <p className="text-[var(--text-secondary)] mb-4">
                                                Generate a new code to continue
                                            </p>
                                            <Button
                                                variant="primary"
                                                onClick={generateCode}
                                            >
                                                <RefreshCw className="w-4 h-4 inline mr-2" />
                                                Generate New Code
                                            </Button>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="bg-white p-4 rounded-xl inline-block mb-4">
                                                <QRCodeSVG
                                                    value={getQRValue()}
                                                    size={180}
                                                    level="M"
                                                />
                                            </div>

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
                                                                ? "bg-success/20 text-success"
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
                                                <div className="w-10 h-10 rounded-full bg-brand/20 flex items-center justify-center">
                                                    <Smartphone className="w-5 h-5 text-brand" />
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
                                                onClick={() => setPendingRevoke(device)}
                                                className="p-2 min-h-[44px] min-w-[44px] text-[var(--text-secondary)] hover:text-danger-light hover:bg-danger/10 rounded-lg transition-all flex items-center justify-center"
                                                aria-label={`Unlink ${device.name}`}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Card>
                    </div>

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

            <ConfirmDialog
                isOpen={pendingRevoke !== null}
                onClose={() => setPendingRevoke(null)}
                onConfirm={() => pendingRevoke && revokeDevice(pendingRevoke)}
                title="Unlink this device?"
                message={`${pendingRevoke?.name ?? "This device"} will be signed out and need a new code to link again.`}
                confirmText="Unlink"
                variant="danger"
            />
        </div>
    );
}

