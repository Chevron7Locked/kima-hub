"use client";

import { Info } from "lucide-react";
import { useState } from "react";

export function KeyboardShortcutsTooltip() {
    const [isVisible, setIsVisible] = useState(false);

    const shortcuts = [
        { key: "Space", action: "Play / Pause" },
        { key: "→", action: "Seek forward 10s" },
        { key: "←", action: "Seek backward 10s" },
        { key: "↑", action: "Volume up 10%" },
        { key: "↓", action: "Volume down 10%" },
        { key: "M", action: "Toggle mute" },
        { key: "N", action: "Next track" },
        { key: "P", action: "Previous track" },
        { key: "S", action: "Toggle shuffle" },
    ];

    return (
        <div className="relative">
            <button
                onMouseEnter={() => setIsVisible(true)}
                onMouseLeave={() => setIsVisible(false)}
                onClick={() => setIsVisible(!isVisible)}
                className="p-1.5 rounded transition-colors text-gray-400 hover:text-white"
                title="Keyboard shortcuts"
            >
                <Info className="w-3.5 h-3.5" />
            </button>

            {isVisible && (
                <div className="absolute bottom-full right-0 mb-2 w-64 bg-[var(--bg-hover)] border border-white/10 rounded-lg shadow-2xl shadow-black/50 p-4 z-50 backdrop-blur-xl">
                    {/* Pointer arrow */}
                    <div className="absolute -bottom-1 right-3 w-2 h-2 bg-[var(--bg-hover)] border-r border-b border-white/10 rotate-45" />

                    <h3 className="text-white font-bold text-sm mb-3 flex items-center gap-2">
                        <Info className="w-4 h-4" />
                        Keyboard Shortcuts
                    </h3>

                    <div className="space-y-2">
                        {shortcuts.map((shortcut) => (
                            <div
                                key={shortcut.key}
                                className="flex items-center justify-between text-xs"
                            >
                                <span className="text-gray-400">
                                    {shortcut.action}
                                </span>
                                <kbd className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white font-mono text-xs min-w-[40px] text-center">
                                    {shortcut.key}
                                </kbd>
                            </div>
                        ))}
                    </div>

                    <div className="mt-3 pt-3 border-t border-white/10">
                        <p className="text-micro text-gray-500 leading-relaxed">
                            Shortcuts work anywhere except when typing in text fields.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
