import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
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

const montserrat = Montserrat({
    weight: ["300", "400", "500", "600", "700", "800"],
    subsets: ["latin"],
    display: "swap",
    variable: "--font-montserrat",
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
    description: "Self-hosted music streaming platform",
    manifest: "/manifest.webmanifest",
    icons: {
        apple: [
            { url: "/assets/images/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        ],
    },
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "Kima",
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
