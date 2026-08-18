import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface SettingsInputProps {
    id?: string;
    type?: "text" | "password" | "url" | "number";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}

export function SettingsInput({
    id,
    type = "text",
    value,
    onChange,
    placeholder,
    disabled,
    className = ""
}: SettingsInputProps) {
    const [showPassword, setShowPassword] = useState(false);
    const isPassword = type === "password";

    return (
        <div className={`relative ${className}`}>
            <input
                id={id}
                type={isPassword && showPassword ? "text" : type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className={`
                    w-full bg-white/5 text-white text-sm tabular-nums
                    px-3 py-2 rounded-lg
                    border border-white/10 outline-none
                    focus:ring-2 focus:ring-brand/30 focus:border-brand/40
                    placeholder:text-[var(--text-muted)]
                    transition-all
                    hover:bg-white/[0.08] hover:border-white/20
                    focus:bg-white/[0.08]
                    ${isPassword ? 'pr-10' : ''}
                    ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                `}
            />
            {isPassword && (
                <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-white/60 transition-colors"
                >
                    {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                    ) : (
                        <Eye className="w-4 h-4" />
                    )}
                </button>
            )}
        </div>
    );
}
