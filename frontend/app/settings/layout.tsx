import type { ReactNode } from "react";
import { SettingsStateProvider } from "@/features/settings/SettingsState";

/** Every settings page shares one copy of the settings, so unsaved edits survive moving between pages. */
export default function SettingsRouteLayout({ children }: { children: ReactNode }) {
    return <SettingsStateProvider>{children}</SettingsStateProvider>;
}
