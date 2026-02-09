import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import type { AlbumSource } from "../types";
import { useMemo, useEffect } from "react";

export function useAlbumData(albumId?: string) {
    const params = useParams();
    const router = useRouter();
    const id = albumId || (params.id as string);

    // Album data refreshed via download:complete -> invalidate ["album"] in useEventSource
    const {
        data: album,
        isLoading,
        error,
        refetch,
    } = useQuery({
        queryKey: queryKeys.album(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Album ID is required");
            try {
                return await api.getAlbum(id);
            } catch {
                return await api.getAlbumDiscovery(id);
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    // Determine source from the album data (if it came from library or discovery)
    const source: AlbumSource | null = useMemo(() => {
        if (!album) return null;
        return album.owned === true ? "library" : "discovery";
    }, [album]);

    // Handle errors - must be in useEffect to avoid infinite re-renders
    useEffect(() => {
        if (error && !isLoading) {
            toast.error("Failed to load album");
            router.back();
        }
    }, [error, isLoading, router]);

    return {
        album,
        loading: isLoading,
        source,
        reloadAlbum: refetch,
    };
}
