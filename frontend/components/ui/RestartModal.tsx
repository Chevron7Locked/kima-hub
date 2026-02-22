"use client";

import { X, Copy, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "./Button";

interface RestartModalProps {
    isOpen: boolean;
    onClose: () => void;
    changedServices: string[];
}

export function RestartModal({
    isOpen,
    onClose,
    changedServices,
}: RestartModalProps) {
    const [copied, setCopied] = useState(false);
    const command = "docker-compose restart";

    const handleCopy = async () => {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/80 z-[80] "
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
                <div className="bg-[#111] border border-[#1c1c1c] rounded-lg shadow-2xl max-w-md w-full">
                    {/* Header */}
                    <div className="flex items-center justify-between p-6 border-b border-[#1c1c1c]">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                                <Check className="w-6 h-6 text-green-500" />
                            </div>
                            <h2 className="text-xl font-semibold text-white">
                                Settings Saved!
                            </h2>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-white transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-6 space-y-4">
                        <p className="text-gray-300">
                            Your settings have been saved successfully and the
                            <code className="text-purple-400 bg-[#0a0a0a] px-1.5 py-0.5 rounded mx-1">
                                .env
                            </code>
                            file has been updated.
                        </p>

                        {changedServices.length > 0 && (
                            <>
                                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-4">
                                    <p className="text-sm font-medium text-yellow-500 mb-2">
                                        Restart Required
                                    </p>
                                    <p className="text-sm text-gray-300 mb-3">
                                        The following services need a restart to
                                        apply changes:
                                    </p>
                                    <ul className="space-y-1">
                                        {changedServices.map((service) => (
                                            <li
                                                key={service}
                                                className="text-sm text-gray-300 flex items-center gap-2"
                                            >
                                                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                                                {service}
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <div>
                                    <p className="text-sm text-gray-400 mb-2">
                                        Run this command in your terminal:
                                    </p>
                                    <div className="relative">
                                        <div className="bg-[#0a0a0a] border border-[#1c1c1c] rounded-md px-4 py-3 pr-12 font-mono text-sm text-white">
                                            {command}
                                        </div>
                                        <button
                                            onClick={handleCopy}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-[#1a1a1a] rounded transition-colors"
                                            title="Copy to clipboard"
                                        >
                                            {copied ? (
                                                <Check className="w-4 h-4 text-green-500" />
                                            ) : (
                                                <Copy className="w-4 h-4 text-gray-400" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        {changedServices.length === 0 && (
                            <div className="bg-green-500/10 border border-green-500/30 rounded-md p-4">
                                <p className="text-sm text-gray-300">
                                    No restart needed! Changes are applied
                                    immediately.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-end gap-3 p-6 border-t border-[#1c1c1c]">
                        {changedServices.length > 0 && (
                            <Button
                                variant="secondary"
                                onClick={handleCopy}
                                className="flex items-center gap-2"
                            >
                                {copied ? (
                                    <>
                                        <Check className="w-4 h-4" />
                                        Copied!
                                    </>
                                ) : (
                                    <>
                                        <Copy className="w-4 h-4" />
                                        Copy Command
                                    </>
                                )}
                            </Button>
                        )}
                        <Button onClick={onClose}>
                            {changedServices.length > 0
                                ? "I'll Restart Later"
                                : "Close"}
                        </Button>
                    </div>
                </div>
            </div>
        </>
    );
}
