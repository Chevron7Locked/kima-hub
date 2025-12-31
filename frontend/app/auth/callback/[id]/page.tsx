"use client";

import { use, useEffect, useRef, useState } from "react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { api } from "@/lib/api";
import { handleOIDCCallback } from "@/lib/auth/oidc-client";

interface AuthCallbackProps {
    params: Promise<{
        id: string;
    }>;
}

export default function AuthCallbackPage({ params }: AuthCallbackProps) {
    const [error, setError] = useState<string | null>(null);
    const hasStartedRef = useRef(false);
    const { id } = use(params);

    useEffect(() => {
        // Prevent running twice
        if (hasStartedRef.current) {
            return;
        }
        hasStartedRef.current = true;

        const processCallback = async () => {
            try {
                // Handle OIDC callback and get Lidify JWT
                const token = await handleOIDCCallback(id);

                api.setToken(token);

                window.location.href = "/";
            } catch (error: any) {
                console.error("[OIDC Callback] Error:", error);
                setError(error.message);

                // Wait 3 seconds before redirecting
                await new Promise(resolve => setTimeout(resolve, 3000));
                window.location.href = "/login?error=Authentication%20failed";
            }
        };

        processCallback();
    }, []);

    if (error) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-black">
                <div className="text-red-500">Error: {error}</div>
            </div>
        );
    }

    return <LoadingScreen />;
}
