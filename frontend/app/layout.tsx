import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider } from "@/lib/toast-context";
import { DownloadProvider } from "@/lib/download-context";
import { ConditionalAudioProvider } from "@/components/providers/ConditionalAudioProvider";
import { AuthenticatedLayout } from "@/components/layout/AuthenticatedLayout";
import { QueryProvider } from "@/lib/query-client";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { GlobalErrorBoundary } from "@/components/providers/GlobalErrorBoundary";

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
    title: "Lidify - Your Music",
    description: "Self-hosted music streaming platform",
    manifest: "/manifest.webmanifest",
    icons: {
        icon: "/assets/images/Lidify__favicon.ico",
        apple: [
            { url: "/assets/icons/icon-192.webp", sizes: "192x192" },
            { url: "/assets/icons/icon-512.webp", sizes: "512x512" },
        ],
    },
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "Lidify",
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
                        <QueryProvider>
                            <DownloadProvider>
                                <ConditionalAudioProvider>
                                    <ToastProvider>
                                        <AuthenticatedLayout>
                                            {children}
                                        </AuthenticatedLayout>
                                    </ToastProvider>
                                </ConditionalAudioProvider>
                            </DownloadProvider>
                        </QueryProvider>
                    </AuthProvider>
                </GlobalErrorBoundary>
            </body>
        </html>
    );
}
