import { useState, useCallback } from "react";
import { api } from "@/lib/api";

export function useTwoFactor() {
    const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
    const [loadingTwoFactor, setLoadingTwoFactor] = useState(false);
    const [settingUpTwoFactor, setSettingUpTwoFactor] = useState(false);
    const [twoFactorSecret, setTwoFactorSecret] = useState("");
    const [twoFactorQR, setTwoFactorQR] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [disablingTwoFactor, setDisablingTwoFactor] = useState(false);
    const [disableTwoFactorPassword, setDisableTwoFactorPassword] = useState("");
    const [disableTwoFactorToken, setDisableTwoFactorToken] = useState("");
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [showRecoveryCodes, setShowRecoveryCodes] = useState(false);
    const [regeneratingCodes, setRegeneratingCodes] = useState(false);

    const load2FAStatus = useCallback(async () => {
        try {
            setLoadingTwoFactor(true);
            const status = await api.get<{ enabled: boolean }>("/auth/2fa/status");
            setTwoFactorEnabled(status.enabled);
        } catch (error) {
            console.error("Failed to load 2FA status:", error);
        } finally {
            setLoadingTwoFactor(false);
        }
    }, []);

    const setup2FA = async () => {
        try {
            setLoadingTwoFactor(true);
            const response = await api.post<{ secret: string; qrCode: string }>("/auth/2fa/setup", {});
            setTwoFactorSecret(response.secret);
            setTwoFactorQR(response.qrCode);
            setSettingUpTwoFactor(true);
        } catch (error: unknown) {
            console.error("Failed to setup 2FA:", error);
            throw error;
        } finally {
            setLoadingTwoFactor(false);
        }
    };

    const enable2FA = async (token: string) => {
        try {
            setLoadingTwoFactor(true);
            // The server checks the code against the secret it kept at setup, so none is sent back.
            const response = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { token });

            setRecoveryCodes(response.recoveryCodes);
            setShowRecoveryCodes(true);
            setTwoFactorEnabled(true);
            setSettingUpTwoFactor(false);
            setTwoFactorToken("");
        } catch (error: unknown) {
            console.error("Failed to enable 2FA:", error);
            throw error;
        } finally {
            setLoadingTwoFactor(false);
        }
    };

    const disable2FA = async (password: string, token: string) => {
        try {
            setDisablingTwoFactor(true);
            await api.post("/auth/2fa/disable", {
                password,
                token,
            });

            setTwoFactorEnabled(false);
            setDisableTwoFactorPassword("");
            setDisableTwoFactorToken("");
        } catch (error: unknown) {
            console.error("Failed to disable 2FA:", error);
            throw error;
        } finally {
            setDisablingTwoFactor(false);
        }
    };

    /** Replaces the recovery codes with ten new ones and shows them; the old ones stop working. */
    const regenerateRecoveryCodes = async (password: string, token: string) => {
        try {
            setRegeneratingCodes(true);
            setRecoveryCodes(await api.newRecoveryCodes(password, token));
            setShowRecoveryCodes(true);
        } catch (error: unknown) {
            console.error("Failed to make new recovery codes:", error);
            throw error;
        } finally {
            setRegeneratingCodes(false);
        }
    };

    const cancel2FASetup = () => {
        setSettingUpTwoFactor(false);
        setTwoFactorToken("");
        setTwoFactorSecret("");
        setTwoFactorQR("");
    };

    const closeRecoveryCodes = () => {
        setShowRecoveryCodes(false);
        setRecoveryCodes([]);
    };

    return {
        twoFactorEnabled,
        loadingTwoFactor,
        settingUpTwoFactor,
        twoFactorSecret,
        twoFactorQR,
        twoFactorToken,
        disablingTwoFactor,
        regeneratingCodes,
        disableTwoFactorPassword,
        disableTwoFactorToken,
        recoveryCodes,
        showRecoveryCodes,
        setTwoFactorToken,
        setDisableTwoFactorPassword,
        setDisableTwoFactorToken,
        load2FAStatus,
        setup2FA,
        enable2FA,
        disable2FA,
        regenerateRecoveryCodes,
        cancel2FASetup,
        closeRecoveryCodes,
    };
}
