interface SettingsToggleProps {
    id?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

export function SettingsToggle({ id, checked, onChange, disabled }: SettingsToggleProps) {
    return (
        <label className="relative inline-flex items-center cursor-pointer">
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                disabled={disabled}
                className="sr-only peer"
            />
            <div className={`
                w-10 h-6 rounded-full transition-colors
                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                ${checked ? 'bg-brand' : 'bg-white/10'}
                peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-brand/30
                after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                after:bg-white after:rounded-full after:h-5 after:w-5
                after:transition-transform after:duration-200
                ${checked ? 'after:translate-x-4' : 'after:translate-x-0'}
            `} />
        </label>
    );
}
