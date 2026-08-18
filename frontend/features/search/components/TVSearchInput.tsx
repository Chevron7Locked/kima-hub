"use client";

import { useState, useRef, useEffect } from "react";
import { Search as SearchIcon } from "lucide-react";
import { useIsTV } from "@/lib/tv-utils";

interface TVSearchInputProps {
    initialQuery?: string;
    onSearch: (query: string) => void;
}

export function TVSearchInput({ initialQuery = "", onSearch }: TVSearchInputProps) {
    const isTV = useIsTV();
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState(initialQuery);
    const [isFocused, setIsFocused] = useState(false);

    // Update query when initialQuery changes
    useEffect(() => {
        setQuery(initialQuery);
    }, [initialQuery]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (query.trim()) {
            onSearch(query.trim());
            // Blur the input after search to return to D-pad navigation
            inputRef.current?.blur();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // On Enter, submit the search
        if (e.key === "Enter") {
            handleSubmit(e);
        }
        // On Escape, blur the input
        if (e.key === "Escape") {
            inputRef.current?.blur();
        }
    };

    // Only render this component in TV mode
    if (!isTV) {
        return null;
    }

    return (
        <div className="mb-8" data-tv-section="tv-search">
            <form onSubmit={handleSubmit}>
                <div className="relative max-w-2xl">
                    <SearchIcon className="absolute left-5 top-1/2 -translate-y-1/2 w-6 h-6 text-[var(--text-secondary)]" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={() => setIsFocused(true)}
                        onBlur={() => setIsFocused(false)}
                        placeholder="Press Enter to search..."
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoComplete="off"
                        data-tv-card
                        data-tv-card-index={0}
                        tabIndex={0}
                        className={`
                            w-full h-16 pl-14 pr-6
                            bg-[var(--bg-hover)]
                            rounded-lg
                            text-xl text-white
                            placeholder-gray-500
                            transition-all
                            outline-none
                            border-2
                            ${isFocused
                                ? "border-[var(--color-brand)] bg-[#242424]"
                                : "border-transparent hover:bg-[#242424]"
                            }
                        `}
                    />
                    {query && (
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 text-sm text-[var(--text-muted)]">
                            Press Enter to search
                        </div>
                    )}
                </div>
            </form>
        </div>
    );
}
