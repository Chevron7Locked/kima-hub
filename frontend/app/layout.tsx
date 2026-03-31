import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { FeaturesProvider } from "@/lib/features-context";
import { ToastProvider } from "@/lib/toast-context";
import { DownloadProvider } from "@/lib/download-context";
import { DownloadProgressProvider } from "@/lib/download-progress-context";
import { ConditionalAudioProvider } from "@/components/providers/ConditionalAudioProvider";
import { AuthenticatedLayout } from "@/components/layout/AuthenticatedLayout";
import { QueryProvider } from "@/lib/query-client";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { GlobalErrorBoundary } from "@/components/providers/GlobalErrorBoundary";
import { ActivityPanelSettingsProvider } from "@/lib/activity-panel-settings-context";

const montserrat = localFont({
    src: "../public/fonts/montserrat-latin.woff2",
    variable: "--font-montserrat",
    display: "swap",
    weight: "300 800",
});

// Viewport configuration - separate export for Next.js 14+
export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: "cover",
    themeColor: "#000000",
};

export const metadata: Metadata = {
    title: "Kima - Your Music",
    description: "Self-hosted music streaming platform. https://github.com/Chevron7Locked/kima-hub",
    manifest: "/manifest.webmanifest",
    icons: {
        apple: [
            { url: "/assets/images/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        ],
    },
    appleWebApp: {
        // capable is intentionally omitted (defaults to false).
        // iOS standalone PWAs have a WebKit bug (#261858) where the audio
        // session is suspended on background and cannot be reactivated from
        // Control Center. By not declaring capable, "Add to Home Screen"
        // creates a Safari bookmark instead, which has full audio support.
        statusBarStyle: "black-translucent",
        title: "Kima",
    },
    openGraph: {
        title: "Kima",
        description: "Self-hosted music streaming platform",
        siteName: "Kima",
        url: "https://github.com/Chevron7Locked/kima-hub",
        type: "website",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${montserrat.variable} antialiased`}
                style={{ fontFamily: "var(--font-montserrat)" }}
            >
                <GlobalErrorBoundary>
                    <ServiceWorkerRegistration />
                    <AuthProvider>
                        <FeaturesProvider>
                            <QueryProvider>
                                <DownloadProgressProvider>
                                    <DownloadProvider>
                                        <ConditionalAudioProvider>
                                            <ToastProvider>
                                                <ActivityPanelSettingsProvider>
                                                    <AuthenticatedLayout>
                                                        {children}
                                                    </AuthenticatedLayout>
                                                </ActivityPanelSettingsProvider>
                                            </ToastProvider>
                                        </ConditionalAudioProvider>
                                    </DownloadProvider>
                                </DownloadProgressProvider>
                            </QueryProvider>
                        </FeaturesProvider>
                    </AuthProvider>
                </GlobalErrorBoundary>
            </body>
        </html>
    );
}
