"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useMemo,
    useCallback,
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
    completeOidcLogin: (code: string, state: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const publicPaths = ["/login", "/register", "/onboarding", "/sync", "/share", "/auth"];

export function AuthProvider({ children }: { children: ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        // Check if user has valid session on mount ONLY
        const checkAuth = async () => {
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
            } catch {
                setIsAuthenticated(false);
                setUser(null);

                // If we're already on onboarding page, allow access
                if (pathname === "/onboarding") {
                    setIsLoading(false);
                    return;
                }

                // If not on a public path, check if we need onboarding
                if (!publicPaths.some(p => pathname === p || pathname.startsWith(p + "/"))) {
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
                        // Intentionally ignored: if onboarding status check fails, assume users exist and proceed to login
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

    const login = useCallback(async (
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
        } catch (error: unknown) {
            console.error("[AUTH] Login failed:", error instanceof Error ? error.message : error);
            throw error;
        }
    }, [router]);

    const completeOidcLogin = useCallback(async (code: string, state: string) => {
        const userData = await api.oidcCallback(code, state);
        setUser(userData);
        setIsAuthenticated(true);
        if (userData.onboardingComplete === false) {
            router.push("/onboarding");
        } else {
            router.push("/");
        }
    }, [router]);

    const logout = useCallback(async () => {
        await api.logout();
        setIsAuthenticated(false);
        setUser(null);
        router.push("/login");
    }, [router]);

    // Memoize context value to prevent unnecessary re-renders
    const contextValue = useMemo(() => ({
        isAuthenticated,
        isLoading,
        user,
        login,
        completeOidcLogin,
        logout,
    }), [isAuthenticated, isLoading, user, login, completeOidcLogin, logout]);

    return (
        <AuthContext.Provider value={contextValue}>
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
