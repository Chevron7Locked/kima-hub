"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "./api";

interface User {
    id: string;
    username: string;
    role: string;
    onboardingComplete?: boolean;
}

interface AuthContextType {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: User | null;
    login: (
        username: string,
        password: string,
        token?: string
    ) => Promise<void>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const publicPaths = ["/login", "/login/credentials", "/register", "/onboarding", "/sync"];

export function AuthProvider({ children }: { children: ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        // Check if user has valid session on mount ONLY
        const checkAuth = async () => {
            // If we're on the OIDC callback page, or if URL has OIDC callback params, don't check auth yet.
            // Let the callback page handle the token exchange first
            if (typeof window !== "undefined") {
                const urlParams = new URLSearchParams(window.location.search);
                const hasOidcCallback = urlParams.has("code") || urlParams.has("state");

                // Accept provider-specific callback paths like /auth/callback/:id
                if ((pathname && pathname.startsWith("/auth/callback")) || hasOidcCallback) {
                    setIsLoading(false);
                    return;
                }
            }

            // Check for token in URL (from redirect after login)
            if (typeof window !== "undefined") {
                const urlParams = new URLSearchParams(window.location.search);
                const tokenFromUrl = urlParams.get("token");
                if (tokenFromUrl) {
                    // Store the token from URL
                    api.setToken(tokenFromUrl);
                    // Clean up URL (remove token param)
                    const cleanUrl = window.location.pathname;
                    window.history.replaceState({}, "", cleanUrl);
                }
            }

            try {
                const userData = await api.getCurrentUser();
                setUser(userData);
                setIsAuthenticated(true);

                // Check onboarding status - redirect if needed
                if (
                    userData.onboardingComplete === false &&
                    pathname !== "/onboarding"
                ) {
                    router.push("/onboarding");
                } else if (
                    userData.onboardingComplete &&
                    pathname === "/onboarding"
                ) {
                    router.push("/");
                }
            } catch (error) {
                setIsAuthenticated(false);
                setUser(null);

                // If we're already on onboarding page, allow access
                if (pathname === "/onboarding") {
                    setIsLoading(false);
                    return;
                }

                // If not on a public path, check if we need onboarding
                if (!publicPaths.includes(pathname) || (pathname && pathname.startsWith("/auth/callback/"))) {
                    // Check if any users exist in the system
                    try {
                        const status = await api.get<{ hasAccount: boolean }>(
                            "/onboarding/status"
                        );

                        if (!status.hasAccount) {
                            // No users exist - redirect to onboarding
                            router.push("/onboarding");
                            return;
                        }
                    } catch {
                        // If status check fails, assume users exist
                    }
                    // Users exist but not logged in - redirect to login
                    router.push("/login");
                }
            } finally {
                setIsLoading(false);
            }
        };

        checkAuth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Only run once on mount

    const login = async (
        username: string,
        password: string,
        token?: string
    ) => {
        try {
            const userData = await api.login(username, password, token);

            // Check if 2FA is required
            if (userData.requires2FA) {
                // Don't set user or redirect, just throw an error to trigger 2FA UI
                throw new Error("2FA token required");
            }

            setUser(userData);
            setIsAuthenticated(true);

            // Redirect based on onboarding status
            if (userData.onboardingComplete === false) {
                router.push("/onboarding");
            } else {
                router.push("/");
            }
        } catch (error: any) {
            console.error("[AUTH] Login failed:", error.message);
            // Re-throw the error so the login page can handle it
            throw error;
        }
    };

    const logout = async () => {
        await api.logout();
        setIsAuthenticated(false);
        setUser(null);
        router.push("/login");
    };

    return (
        <AuthContext.Provider
            value={{ isAuthenticated, isLoading, user, login, logout }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
