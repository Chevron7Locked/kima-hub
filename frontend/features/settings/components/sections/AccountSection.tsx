"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { useTwoFactor } from "../../hooks/useTwoFactor";
import { Modal } from "@/components/ui/Modal";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Button } from "@/components/ui/Button";
import { CachedImage } from "@/components/ui/CachedImage";
import { copyText } from "@/lib/clipboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function AccountSection() {
    const { user, deleteAccount } = useAuth();
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    // Signs the person out on success (deleteAccount); a refusal, such as for the last admin, shows on the row.
    const handleDeleteAccount = async () => {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteAccount();
            // Stays busy while the sign-in page loads, so the account can't be asked to go twice.
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : "Couldn't delete the account");
            setConfirmingDelete(false);
            setDeleting(false);
        }
    };

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changingPassword, setChangingPassword] = useState(false);
    const [showPasswordForm, setShowPasswordForm] = useState(false);
    const [passwordStatus, setPasswordStatus] = useState<StatusType>("idle");
    const [passwordMessage, setPasswordMessage] = useState("");

    const {
        twoFactorEnabled,
        settingUpTwoFactor,
        twoFactorQR,
        twoFactorSecret,
        recoveryCodes,
        showRecoveryCodes,
        load2FAStatus,
        setup2FA,
        enable2FA,
        disable2FA,
        cancel2FASetup,
        closeRecoveryCodes,
    } = useTwoFactor();

    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [disablePassword, setDisablePassword] = useState("");
    const [disableToken, setDisableToken] = useState("");
    const [showDisableFlow, setShowDisableFlow] = useState(false);
    const [tfaStatus, setTfaStatus] = useState<StatusType>("idle");
    const [tfaMessage, setTfaMessage] = useState("");

    useEffect(() => {
        load2FAStatus();
    }, [load2FAStatus]);

    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword || !confirmPassword) {
            setPasswordStatus("error");
            setPasswordMessage("All fields required");
            return;
        }
        if (newPassword.length < 6) {
            setPasswordStatus("error");
            setPasswordMessage("Min 6 characters");
            return;
        }
        if (newPassword !== confirmPassword) {
            setPasswordStatus("error");
            setPasswordMessage("Passwords don't match");
            return;
        }

        setChangingPassword(true);
        setPasswordStatus("loading");
        try {
            const changed = await api.post<{ token: string; refreshToken: string }>(
                "/auth/change-password",
                { currentPassword, newPassword },
            );
            // The change signs out every other device; this one keeps going on the new tokens.
            api.setToken(changed.token, changed.refreshToken);
            setPasswordStatus("success");
            setPasswordMessage("Changed. Other devices are signed out");
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setTimeout(() => setShowPasswordForm(false), 1500);
        } catch (error: unknown) {
            setPasswordStatus("error");
            setPasswordMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setChangingPassword(false);
        }
    };

    const handleVerify2FA = async () => {
        setTfaStatus("loading");
        try {
            await enable2FA(twoFactorToken);
            setTfaStatus("success");
            setTfaMessage("Enabled");
            setTwoFactorToken("");
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(error instanceof Error ? error.message : "Invalid code");
        }
    };

    const handleDisable2FA = async () => {
        setTfaStatus("loading");
        try {
            await disable2FA(disablePassword, disableToken);
            setTfaStatus("success");
            setTfaMessage("Disabled");
            setDisablePassword("");
            setDisableToken("");
            setShowDisableFlow(false);
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(error instanceof Error ? error.message : "Failed");
        }
    };

    return (
        <>
            <SettingsSection id="account" title="Account">
                <SettingsRow label="Signed in as" description={user?.role === "admin" ? "Administrator" : "Member"}>
                    <span className="text-sm text-white">{user?.username}</span>
                </SettingsRow>

                <SettingsRow
                    label="Password"
                    description="Change your account password"
                >
                    {!showPasswordForm ? (
                        <button
                            onClick={() => setShowPasswordForm(true)}
                            className="text-xs text-brand hover:text-brand-hover transition-colors"
                        >
                            Change
                        </button>
                    ) : (
                        <button
                            onClick={() => setShowPasswordForm(false)}
                            className="text-xs text-[var(--text-muted)] hover:text-white/70 transition-colors"
                        >
                            Cancel
                        </button>
                    )}
                </SettingsRow>

                {showPasswordForm && (
                    <div className="py-4 space-y-3 border-t border-b border-white/5">
                        <SettingsInput
                            type="password"
                            value={currentPassword}
                            onChange={setCurrentPassword}
                            placeholder="Current password"
                        />
                        <SettingsInput
                            type="password"
                            value={newPassword}
                            onChange={setNewPassword}
                            placeholder="New password (min 6 characters)"
                        />
                        <SettingsInput
                            type="password"
                            value={confirmPassword}
                            onChange={setConfirmPassword}
                            placeholder="Confirm new password"
                        />
                        <div className="inline-flex items-center gap-3">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleChangePassword}
                                disabled={changingPassword || !currentPassword || !newPassword || newPassword !== confirmPassword}
                            >
                                {changingPassword ? "Changing..." : "Change Password"}
                            </Button>
                            <InlineStatus
                                status={passwordStatus}
                                message={passwordMessage}
                                onClear={() => setPasswordStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                <SettingsRow
                    label="Two-factor authentication"
                    description={twoFactorEnabled ? "Enabled" : "Add extra security to your account"}
                >
                    {!settingUpTwoFactor && !showDisableFlow && (
                        twoFactorEnabled ? (
                            <button
                                onClick={() => setShowDisableFlow(true)}
                                className="text-xs text-danger-light hover:brightness-125 transition-colors"
                            >
                                Disable
                            </button>
                        ) : (
                            <button
                                onClick={setup2FA}
                            className="text-xs text-brand hover:text-brand-hover transition-colors"
                            >
                                Enable
                            </button>
                        )
                    )}
                </SettingsRow>

                {settingUpTwoFactor && (
                    <div className="py-4 space-y-4 border-t border-b border-white/5">
                        <p className="text-xs text-[var(--text-muted)]">
                            Scan the QR code with your authenticator app, then enter the code below.
                        </p>

                        {twoFactorQR && (
                            <div className="flex justify-center">
                                <div className="bg-white p-3 rounded-lg">
                                    <CachedImage src={twoFactorQR} alt="2FA QR Code" width={160} height={160} className="w-40 h-40" />
                                </div>
                            </div>
                        )}

                        {twoFactorSecret && (
                            <div className="text-center">
                                <p className="text-xs text-[var(--text-muted)] mb-1">Manual entry code</p>
                                <code className="text-sm text-white bg-white/5 border border-white/10 px-3 py-1 rounded-lg font-mono">
                                    {twoFactorSecret}
                                </code>
                            </div>
                        )}

                        <SettingsInput
                            type="text"
                            value={twoFactorToken}
                            onChange={(v) => setTwoFactorToken(v.replace(/\D/g, "").slice(0, 6))}
                            placeholder="Enter 6-digit code"
                        />

                        <div className="inline-flex items-center gap-3">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleVerify2FA}
                                disabled={twoFactorToken.length !== 6}
                            >
                                Verify
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { cancel2FASetup(); setTwoFactorToken(""); }}
                            >
                                Cancel
                            </Button>
                            <InlineStatus
                                status={tfaStatus}
                                message={tfaMessage}
                                onClear={() => setTfaStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                {showDisableFlow && (
                    <div className="py-4 space-y-3 border-t border-b border-white/5">
                        <p className="text-xs tabular-nums text-warning">
                            Enter your password and current code to disable 2FA.
                        </p>
                        <SettingsInput
                            type="password"
                            value={disablePassword}
                            onChange={setDisablePassword}
                            placeholder="Password"
                        />
                        <SettingsInput
                            type="text"
                            value={disableToken}
                            onChange={(v) => setDisableToken(v.replace(/\D/g, "").slice(0, 6))}
                            placeholder="6-digit code"
                        />
                        <div className="inline-flex items-center gap-3">
                            <Button
                                variant="danger"
                                size="sm"
                                onClick={handleDisable2FA}
                                disabled={!disablePassword || disableToken.length !== 6}
                            >
                                Disable 2FA
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { setShowDisableFlow(false); setDisablePassword(""); setDisableToken(""); }}
                            >
                                Cancel
                            </Button>
                            <InlineStatus
                                status={tfaStatus}
                                message={tfaMessage}
                                onClear={() => setTfaStatus("idle")}
                            />
                        </div>
                    </div>
                )}
                <SettingsRow
                    label="Delete account"
                    description={deleteError ?? "Deletes your account and everything that is yours here: playlists, plays, likes and settings."}
                >
                    <button
                        onClick={() => setConfirmingDelete(true)}
                        className="text-xs text-danger-light hover:brightness-125 transition-colors"
                    >
                        Delete
                    </button>
                </SettingsRow>
            </SettingsSection>

            <ConfirmDialog
                isOpen={confirmingDelete}
                onClose={() => setConfirmingDelete(false)}
                onConfirm={() => void handleDeleteAccount()}
                title="Delete your account?"
                message="Your account, playlists, plays, likes and settings are deleted. This can't be undone."
                confirmText="Delete account"
                cancelText="Keep it"
                variant="danger"
                busy={deleting}
                closeOnConfirm={false}
            />

            <Modal isOpen={showRecoveryCodes} onClose={closeRecoveryCodes} title="Recovery Codes">
                <div className="space-y-4">
                    <div className="bg-danger/10 border border-danger/30 rounded-lg p-3">
                        <p className="text-xs text-danger-light">
                            Save these codes! You&apos;ll need them if you lose your authenticator.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {recoveryCodes.map((code, i) => (
                            <code key={i} className="text-sm text-white bg-white/5 border border-white/10 px-3 py-2 rounded-lg font-mono">
                                {code}
                            </code>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void copyText(recoveryCodes.join("\n"))}
                        >
                            Copy
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={closeRecoveryCodes}
                        >
                            Done
                        </Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
