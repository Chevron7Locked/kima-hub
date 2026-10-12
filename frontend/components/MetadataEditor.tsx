"use client";

import { useRef, useState } from "react";
import { Edit, X, Save } from "lucide-react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { GradientSpinner } from "./ui/GradientSpinner";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/hooks/useDialog";
import { CachedImage } from "@/components/ui/CachedImage";

interface MetadataEditorProps {
    type: "artist" | "album" | "track";
    id: string;
    currentData: {
        name?: string;
        title?: string;
        bio?: string;
        genres?: string[];
        year?: number;
        mbid?: string;
        rgMbid?: string;
        coverUrl?: string;
        heroUrl?: string;
        // Original values for comparison (when user overrides exist)
        _originalName?: string;
        _originalBio?: string | null;
        _originalGenres?: string[];
        _originalHeroUrl?: string | null;
        _originalTitle?: string;
        _originalYear?: number | null;
        _originalCoverUrl?: string | null;
        _hasUserOverrides?: boolean;
    };
    onSave?: (updatedData: Record<string, unknown> | null) => void;
}

/** A pencil button that opens a dialog for editing artist, album or track metadata. */
export function MetadataEditor({
    type,
    id,
    currentData,
    onSave,
}: MetadataEditorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [formData, setFormData] = useState(currentData);
    const hasOverrides = currentData._hasUserOverrides ?? false;

    const handleOpen = () => {
        setFormData(currentData);
        setIsOpen(true);
    };

    const handleClose = () => {
        setIsOpen(false);
        setFormData(currentData);
    };

    const dialogRef = useRef<HTMLDivElement>(null);
    useDialog(dialogRef, isOpen, handleClose);

    const handleReset = async () => {
        if (
            !confirm(
                "reset all metadata to original values? this cannot be undone."
            )
        ) {
            return;
        }

        setIsResetting(true);
        try {
            if (type === "artist") {
                await api.resetArtistMetadata(id);
            } else if (type === "album") {
                await api.resetAlbumMetadata(id);
            } else {
                await api.resetTrackMetadata(id);
            }

            onSave?.(null);
            setIsOpen(false);
        } catch (error: unknown) {
            notify.error("Failed to reset metadata", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setIsResetting(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            let response;
            if (type === "artist") {
                response = await api.updateArtistMetadata(id, formData);
            } else if (type === "album") {
                response = await api.updateAlbumMetadata(id, formData);
            } else {
                response = await api.updateTrackMetadata(id, formData);
            }

            onSave?.(response);
            setIsOpen(false);
        } catch (error: unknown) {
            notify.error("Failed to update metadata", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setIsSaving(false);
        }
    };

    const handleChange = (field: string, value: string | number | string[] | null) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    return (
        <>
            <button
                onClick={handleOpen}
                className="p-2 rounded-full bg-black/40 hover:bg-black/60 transition-all opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch-reveal"
                title={`Edit ${type} metadata`.toLowerCase()}
                aria-label={`Edit ${type} metadata`}
            >
                <Edit className="w-4 h-4 text-white" />
            </button>

            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/80 flex items-center justify-center z-(--z-modal) p-4"
                    onClick={handleClose}
                >
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="metadata-editor-title"
                        onClick={(e) => e.stopPropagation()}
                        className="bg-[#121212] rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
                    >
                        <div className="flex items-center justify-between p-6 border-b border-white/10">
                            <h2 id="metadata-editor-title" className="text-2xl font-bold text-white">
                                Edit{" "}
                                {type === "artist"
                                    ? "Artist"
                                    : type === "album"
                                    ? "Album"
                                    : "Track"}{" "}
                                Metadata
                            </h2>
                            <button
                                onClick={handleClose}
                                aria-label="Close"
                                className="p-2 hover:bg-white/10 rounded-full transition-all"
                            >
                                <X className="w-6 h-6 text-white" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "artist"
                                        ? "Artist Name"
                                        : type === "album"
                                        ? "Album Title"
                                        : "Track Title"}
                                </label>
                                <input
                                    type="text"
                                    value={
                                        formData.name || formData.title || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "name"
                                                : "title",
                                            e.target.value
                                        )
                                    }
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                />
                                {type === "artist" &&
                                    currentData._originalName &&
                                    currentData._originalName !==
                                        (formData.name || "") && (
                                        <p className="mt-1 text-xs text-[var(--text-muted)]">
                                            Original:{" "}
                                            {currentData._originalName}
                                        </p>
                                    )}
                                {type !== "artist" &&
                                    currentData._originalTitle &&
                                    currentData._originalTitle !==
                                        (formData.title || "") && (
                                        <p className="mt-1 text-xs text-[var(--text-muted)]">
                                            Original:{" "}
                                            {currentData._originalTitle}
                                        </p>
                                    )}
                            </div>

                            {type === "artist" && (
                                <div>
                                    <label className="block text-sm font-bold text-white mb-2">
                                        Biography
                                    </label>
                                    <textarea
                                        value={formData.bio || ""}
                                        onChange={(e) =>
                                            handleChange("bio", e.target.value)
                                        }
                                        rows={6}
                                        className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none resize-none"
                                    />
                                    {currentData._originalBio &&
                                        currentData._originalBio !==
                                            (formData.bio || "") && (
                                            <p className="mt-1 text-xs text-[var(--text-muted)]">
                                                Original:{" "}
                                                {currentData._originalBio.substring(
                                                    0,
                                                    100
                                                )}
                                                ...
                                            </p>
                                        )}
                                </div>
                            )}

                            {type === "album" && (
                                <div>
                                    <label className="block text-sm font-bold text-white mb-2">
                                        Release Year
                                    </label>
                                    <input
                                        type="number"
                                        value={formData.year || ""}
                                        onChange={(e) =>
                                            handleChange(
                                                "year",
                                                parseInt(e.target.value)
                                            )
                                        }
                                        className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                    />
                                    {currentData._originalYear &&
                                        currentData._originalYear !==
                                            (formData.year || null) && (
                                            <p className="mt-1 text-xs text-[var(--text-muted)]">
                                                Original:{" "}
                                                {currentData._originalYear}
                                            </p>
                                        )}
                                </div>
                            )}

                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    Genres
                                    <span className="text-xs text-[var(--text-secondary)] ml-2">
                                        (comma-separated)
                                    </span>
                                </label>
                                <input
                                    type="text"
                                    value={formData.genres?.join(", ") || ""}
                                    onChange={(e) =>
                                        handleChange(
                                            "genres",
                                            e.target.value
                                                .split(",")
                                                .map((g) => g.trim())
                                                .filter(Boolean)
                                        )
                                    }
                                    placeholder="Rock, Alternative, Indie"
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                />
                                {currentData._originalGenres &&
                                    currentData._originalGenres.length > 0 &&
                                    JSON.stringify(
                                        currentData._originalGenres.sort()
                                    ) !==
                                        JSON.stringify(
                                            (formData.genres || []).sort()
                                        ) && (
                                        <p className="mt-1 text-xs text-[var(--text-muted)]">
                                            Original:{" "}
                                            {currentData._originalGenres.join(
                                                ", "
                                            )}
                                        </p>
                                    )}
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    MusicBrainz ID
                                    <span className="text-xs text-[var(--text-secondary)] ml-2">
                                        (leave empty to auto-fetch)
                                    </span>
                                </label>
                                <input
                                    type="text"
                                    value={
                                        type === "artist"
                                            ? formData.mbid || ""
                                            : type === "album"
                                            ? formData.rgMbid || ""
                                            : formData.mbid || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "mbid"
                                                : type === "album"
                                                ? "rgMbid"
                                                : "mbid",
                                            e.target.value
                                        )
                                    }
                                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none text-sm"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "artist"
                                        ? "Artist Image URL"
                                        : "Cover Art URL"}
                                    <span className="text-xs text-[var(--text-secondary)] ml-2">
                                        (leave empty to auto-fetch)
                                    </span>
                                </label>
                                <input
                                    type="url"
                                    value={
                                        type === "artist"
                                            ? formData.heroUrl || ""
                                            : formData.coverUrl || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "heroUrl"
                                                : "coverUrl",
                                            e.target.value
                                        )
                                    }
                                    placeholder="https://..."
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none text-sm"
                                />
                                {type === "artist" &&
                                    currentData._originalHeroUrl &&
                                    currentData._originalHeroUrl !==
                                        (formData.heroUrl || "") && (
                                        <p className="mt-1 text-xs text-[var(--text-muted)] truncate">
                                            Original:{" "}
                                            {currentData._originalHeroUrl}
                                        </p>
                                    )}
                                {type === "album" &&
                                    currentData._originalCoverUrl &&
                                    currentData._originalCoverUrl !==
                                        (formData.coverUrl || "") && (
                                        <p className="mt-1 text-xs text-[var(--text-muted)] truncate">
                                            Original:{" "}
                                            {currentData._originalCoverUrl}
                                        </p>
                                    )}
                                {(formData.heroUrl || formData.coverUrl) && (
                                    <div className="mt-2">
                                        <CachedImage
                                            src={
                                                (formData.heroUrl ||
                                                formData.coverUrl)!
                                            }
                                            alt="Preview"
                                            width={128}
                                            height={128}
                                            className="w-32 h-32 object-cover rounded"
                                        />
                                    </div>
                                )}
                            </div>

                            <div className="bg-warning/10 border border-warning/20 rounded p-4">
                                <p className="text-sm text-warning">
                                    <strong>Note:</strong> Manually edited
                                    metadata will not be overwritten by
                                    automatic enrichment.
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center justify-end gap-3 p-6 border-t border-white/10">
                            {hasOverrides && (
                                <Button
                                    variant="danger"
                                    onClick={handleReset}
                                    disabled={isSaving || isResetting}
                                >
                                    {isResetting
                                        ? "Resetting..."
                                        : "Reset to Original"}
                                </Button>
                            )}
                            <Button
                                variant="secondary"
                                onClick={handleClose}
                                disabled={isSaving}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleSave}
                                disabled={isSaving}
                            >
                                {isSaving ? (
                                    <>
                                        <GradientSpinner size="sm" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Save className="w-4 h-4" />
                                        Save Changes
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
