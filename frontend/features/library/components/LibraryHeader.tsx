interface LibraryHeaderProps {
  totalItems: number;
  activeTab: string;
}

export function LibraryHeader({ totalItems, activeTab }: LibraryHeaderProps) {
  return (
    <div className="relative bg-gradient-to-b from-[#0a0a0a] via-[#0f0f0f] to-transparent pt-6 pb-8 px-6 md:px-8">
      {/* System status indicator */}
      <div className="flex items-center gap-2 mb-6">
        <div className="w-1.5 h-1.5 bg-[#22c55e] rounded-full" />
        <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
          Archive Online
        </span>
      </div>

      {/* Title + Live Stats */}
      <div className="flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-none mb-3">
            Collection
          </h1>
          <p className="text-sm font-mono text-gray-500">
            Personal audio archive / Full catalog access
          </p>
        </div>

        {/* Live counter */}
        <div className="flex items-baseline gap-2 border-2 border-white/10 bg-[var(--bg-primary)] px-4 py-3 rounded">
          <span className="text-4xl font-bold font-mono text-[#eab308]">
            {totalItems.toLocaleString()}
          </span>
          <span className="text-xs font-mono text-gray-500 uppercase">
            {activeTab === "artists" ? "artists" : activeTab === "albums" ? "albums" : "tracks"}
          </span>
        </div>
      </div>
    </div>
  );
}
