import { Tab } from "../types";
import { cn } from "@/utils/cn";
import { Users, Disc3, ListMusic } from "lucide-react";

interface LibraryTabsProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const tabs = [
  { id: "artists" as Tab, label: "Artists", icon: Users, gradient: "from-[#ec4899] to-[#db2777]" },
  { id: "albums" as Tab, label: "Albums", icon: Disc3, gradient: "from-[#22c55e] to-[#16a34a]" },
  { id: "tracks" as Tab, label: "Tracks", icon: ListMusic, gradient: "from-[#a855f7] to-[#9333ea]" },
];

export function LibraryTabs({ activeTab, onTabChange }: LibraryTabsProps) {
  return (
    <div data-tv-section="library-tabs" className="relative">
      {/* Glassmorphism background */}
      <div className="absolute -inset-x-4 -inset-y-2 bg-[var(--bg-primary)]/60 backdrop-blur-xl rounded-2xl border border-white/5" />

      {/* Tab buttons */}
      <div className="relative flex justify-center gap-2 p-2">
        {tabs.map((tab, index) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              data-tv-card
              data-tv-card-index={index}
              tabIndex={0}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                // Tighter padding and gap below sm: at full desktop padding the labels
                // clip inside the pill on a phone.
                "relative px-2.5 py-2.5 sm:px-6 sm:py-3 text-sm font-black uppercase tracking-wider rounded-xl transition-all duration-300 flex items-center gap-2 overflow-hidden group",
                isActive
                  ? "text-black scale-105 shadow-lg"
                  : "text-gray-400 hover:text-white hover:scale-105 bg-white/5 hover:bg-white/10"
              )}
            >
              {/* Active gradient background */}
              {isActive && (
                <>
                  <div
                    className={cn(
                      "absolute inset-0 bg-gradient-to-r",
                      tab.gradient
                    )}
                  />
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                </>
              )}

              {/* Content */}
              <span className="relative z-10 flex items-center gap-2 sm:gap-2.5">
                <Icon className="w-4 h-4" />
                {tab.label}
              </span>

              {/* Hover effect */}
              {!isActive && (
                <div
                  className={cn(
                    "absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity duration-300 bg-gradient-to-r",
                    tab.gradient
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
