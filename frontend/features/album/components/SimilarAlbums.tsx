import React from 'react';
import { PlayableCard } from '@/components/ui/PlayableCard';
import { Disc3 } from 'lucide-react';
import { api } from '@/lib/api';
import { SimilarAlbum } from '../types';
import type { ColorPalette } from '@/hooks/useImageColor';
import { SectionHeader } from '@/features/home/components/SectionHeader';

interface SimilarAlbumsProps {
  similarAlbums: SimilarAlbum[];
  colors: ColorPalette | null;
  onNavigate: (albumId: string) => void;
}

export function SimilarAlbums({ similarAlbums, colors, onNavigate }: SimilarAlbumsProps) {
  return (
    <section>
      <SectionHeader color="albums" title="More Like This" />
      <div data-tv-section="similar-albums" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {similarAlbums.map((album, index) => (
          <PlayableCard
            key={album.id}
            href={`/album/${album.id}`}
            coverArt={album.coverArt ? api.getCoverArtUrl(album.coverArt, 300) : album.coverUrl}
            title={album.title}
            subtitle={album.artist?.name}
            placeholderIcon={<Disc3 className="w-12 h-12 text-[var(--text-muted)]" />}
            circular={false}
            badge={album.owned ? "owned" : undefined}
            colors={colors}
            showPlayButton={false}
            onClick={() => onNavigate(album.id)}
            tvCardIndex={index}
          />
        ))}
      </div>
    </section>
  );
}
