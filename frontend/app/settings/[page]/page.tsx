import { notFound } from "next/navigation";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { SETTINGS_PAGES, type SettingsPageSlug } from "@/features/settings/pages";

/** The admin pages of settings: library, sources, server, people. */
export default async function SettingsSubPage({ params }: { params: Promise<{ page: string }> }) {
    const { page } = await params;
    const known = SETTINGS_PAGES.find((p) => p.slug === page && p.slug !== "you");
    if (!known) notFound();
    return <SettingsScreen slug={known.slug as SettingsPageSlug} />;
}
