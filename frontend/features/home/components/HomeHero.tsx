"use client";

const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "GOOD\nMORNING";
    if (hour < 18) return "GOOD\nAFTERNOON";
    return "GOOD\nEVENING";
};

export function HomeHero() {
    const greeting = getGreeting();
    const [line1, line2] = greeting.split("\n");

    return (
        <div className="relative bg-gradient-to-b from-[#0a0a0a] via-[#0f0f0f] to-transparent pt-6 pb-8 px-4 sm:px-6 md:px-8 border-b border-white/5">
            <div className="max-w-[1800px] mx-auto">
                {/* System status indicator */}
                <div className="flex items-center gap-2 mb-6">
                    <div className="w-1.5 h-1.5 bg-brand rounded-full" />
                    <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                        System Online
                    </span>
                </div>

                {/* Title */}
                <div className="flex items-baseline justify-between flex-wrap gap-4">
                    <div>
                        <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-none mb-3">
                            {line1}<br />
                            <span className="text-brand">{line2}</span>
                        </h1>
                        <p className="text-sm font-mono text-gray-500">
                            Personal streaming hub / Your library at a glance
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
