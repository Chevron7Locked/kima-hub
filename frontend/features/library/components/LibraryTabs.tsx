import { Tab } from "../types";
import { cn } from "@/utils/cn";
import { Users, Disc3, ListMusic } from "lucide-react";

interface LibraryTabsProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

// No per-tab colour. A filter is not a category with an identity, and three
// saturated hues on one control read as candy rather than hierarchy. The active
// segment carries the app's one accent; the others carry none.
const tabs = [
  { id: "artists" as Tab, label: "Artists", icon: Users },
  { id: "albums" as Tab, label: "Albums", icon: Disc3 },
  { id: "tracks" as Tab, label: "Tracks", icon: ListMusic },
];

export function LibraryTabs({ activeTab, onTabChange }: LibraryTabsProps) {
  return (
    // A segmented control: one quiet container, one filled segment. What was
    // here before stacked five effects on a three-item filter -- a per-tab
    // gradient, a permanent shimmer sweep, scale-105 on both active AND hover,
    // and a backdrop-blur glass panel behind all of it. None of them carried
    // information; together they made the smallest control on the page the
    // loudest thing on it.
    <div data-tv-section="library-tabs" className="inline-flex items-center gap-1 rounded-xl bg-white/5 p-1">
      {tabs.map((tab, index) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;

        return (
          <button
            key={tab.id}
            data-tv-card
            data-tv-card-index={index}
            tabIndex={0}
            aria-pressed={isActive}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              // min-h matches the Refine control beside it and clears the 44px
              // touch guideline; py alone gave a 36px target.
              "flex items-center gap-2 rounded-lg px-3 sm:px-4 py-2 min-h-[44px] text-sm font-medium transition-colors duration-150",
              isActive
                ? "bg-brand text-black"
                : "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
            )}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
