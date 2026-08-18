import { ChevronDown } from "lucide-react";

interface Option {
    value: string;
    label: string;
    description?: string;
}

interface SettingsSelectProps {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Option[];
    disabled?: boolean;
}

export function SettingsSelect({ id, value, onChange, options, disabled }: SettingsSelectProps) {
    return (
        <div className="relative">
            <select
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className={`
                    appearance-none bg-white/5 text-white text-sm tabular-nums
                    pl-3 pr-8 py-1.5 rounded-lg
                    border border-white/10 outline-none
                    focus:ring-2 focus:ring-brand/30 focus:border-brand/40
                    cursor-pointer transition-all
                    hover:bg-white/[0.08] hover:border-white/20
                    ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                `}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none" />
        </div>
    );
}
