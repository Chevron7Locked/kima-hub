"use client";

import { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
import { SettingsSection, SettingsInput, SettingsSelect, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Button } from "@/components/ui/Button";

interface User {
    id: string;
    username: string;
    role: "user" | "admin";
    createdAt: string;
}

interface UserManagementSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function UserManagementSection({ settings, onUpdate }: UserManagementSectionProps) {
    const { user: currentUser } = useAuth();
    const [users, setUsers] = useState<User[]>([]);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<"user" | "admin">("user");
    const [creating, setCreating] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [createStatus, setCreateStatus] = useState<StatusType>("idle");
    const [createMessage, setCreateMessage] = useState("");
    const [deleteStatus, setDeleteStatus] = useState<StatusType>("idle");
    const [deleteMessage, setDeleteMessage] = useState("");

    // A reload after a create or delete keeps the list on screen until the new one arrives.
    const loadUsers = () =>
        api
            .get<User[]>("/auth/users")
            .then((loaded) => {
                setUsers(loaded);
                setLoadFailed(false);
            })
            .catch(() => setLoadFailed(true))
            .finally(() => setLoading(false));

    useEffect(() => {
        loadUsers();
    }, []);

    const handleCreate = async () => {
        if (!newUsername.trim() || newPassword.length < 6) {
            setCreateStatus("error");
            setCreateMessage("Username required, password 6+ chars");
            return;
        }

        setCreating(true);
        setCreateStatus("loading");
        try {
            await api.post("/auth/create-user", {
                username: newUsername.trim(),
                password: newPassword,
                role: newRole,
            });
            setCreateStatus("success");
            setCreateMessage("Created");
            setNewUsername("");
            setNewPassword("");
            setNewRole("user");
            loadUsers();
        } catch (error: unknown) {
            setCreateStatus("error");
            setCreateMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setCreating(false);
        }
    };

    // Its own dialog, not ConfirmDialog: it stays open to show a failed delete. Each opening starts clean, so a
    // status from an earlier delete never shows against another user.
    const openDelete = (userId: string) => {
        setDeleteStatus("idle");
        setDeleteMessage("");
        setConfirmDelete(userId);
    };
    const closeDelete = () => {
        setDeleteStatus("idle");
        setDeleteMessage("");
        setConfirmDelete(null);
    };

    const handleDelete = async (userId: string) => {
        setDeleteStatus("loading");
        try {
            await api.delete(`/auth/users/${userId}`);
            closeDelete();
            loadUsers();
        } catch (error: unknown) {
            setDeleteStatus("error");
            setDeleteMessage(error instanceof Error ? error.message : "Failed");
        }
    };

    if (currentUser?.role !== "admin") {
        return null;
    }

    return (
        <>
            <SettingsSection
                id="users"
                title="User Management"
                description="Manage users who can access this instance"
                showSeparator={false}
            >
                <SettingsRow
                    label="Let people sign up"
                    description="Anyone who can reach this server may create their own account from the sign-in page. Off, only an admin adds people, below."
                >
                    <SettingsToggle
                        id="registration-open"
                        checked={settings.registrationOpen}
                        onChange={(checked) => onUpdate({ registrationOpen: checked })}
                    />
                </SettingsRow>

                <div className="py-4 mb-4">
                    <h3 className="text-xs text-[var(--text-secondary)] mb-3">Create New User</h3>
                    <div className="space-y-3">
                        <div className="flex gap-3">
                            <SettingsInput
                                value={newUsername}
                                onChange={setNewUsername}
                                placeholder="Username"
                                className="flex-1"
                            />
                            <SettingsInput
                                type="password"
                                value={newPassword}
                                onChange={setNewPassword}
                                placeholder="Password (6+ chars)"
                                className="flex-1"
                            />
                        </div>
                        <div className="inline-flex gap-3 items-center">
                            <SettingsSelect
                                value={newRole}
                                onChange={(v) => setNewRole(v as "user" | "admin")}
                                options={[
                                    { value: "user", label: "User" },
                                    { value: "admin", label: "Admin" },
                                ]}
                            />
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleCreate}
                                disabled={creating || !newUsername.trim() || newPassword.length < 6}
                            >
                                {creating ? "Creating..." : "Create"}
                            </Button>
                            <InlineStatus
                                status={createStatus}
                                message={createMessage}
                                onClear={() => setCreateStatus("idle")}
                            />
                        </div>
                    </div>
                </div>

                <div className="space-y-1">
                    {loading ? (
                        <div className="py-4 text-xs text-[var(--text-muted)]">Loading users...</div>
                    ) : loadFailed && users.length === 0 ? (
                        <div className="py-4 text-xs text-[var(--text-muted)]">
                            Couldn&apos;t load the users.{" "}
                            <button type="button" onClick={() => void loadUsers()} className="text-brand hover:text-brand-hover">
                                Try again
                            </button>
                        </div>
                    ) : users.length === 0 ? (
                        <div className="py-4 text-xs text-[var(--text-muted)]">No users found</div>
                    ) : (
                        users.map((user) => (
                            <div
                                key={user.id}
                                className="flex items-center justify-between py-3 px-3 rounded-lg hover:bg-white/[0.03] border border-transparent hover:border-white/5 transition-all"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-xs font-semibold text-brand">
                                        {user.username[0].toUpperCase()}
                                    </div>
                                    <div>
                                        <div className="text-sm font-medium text-white">
                                            {user.username}
                                            {currentUser?.id === user.id && (
                                                <span className="text-xs text-[var(--text-muted)] ml-2">(you)</span>
                                            )}
                                        </div>
                                        <div className="text-xs tabular-nums text-[var(--text-muted)]">
                                            {user.role === "admin" ? "Admin" : "User"}
                                        </div>
                                    </div>
                                </div>

                                {currentUser?.id !== user.id && (
                                    <button
                                        onClick={() => openDelete(user.id)}
                                        className="p-2 text-[var(--text-muted)] hover:text-danger-light transition-colors"
                                        aria-label={`delete ${user.username}`}
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </SettingsSection>

            <Modal
                isOpen={!!confirmDelete}
                onClose={closeDelete}
                title="Delete User"
            >
                <div className="space-y-4">
                    <p className="text-xs text-[var(--text-secondary)]">
                        Delete {users.find((u) => u.id === confirmDelete)?.username ?? "this user"} and everything they made? This cannot be undone.
                    </p>
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={deleteStatus}
                            message={deleteMessage}
                            onClear={() => setDeleteStatus("idle")}
                        />
                        <Button variant="ghost" size="sm" onClick={closeDelete}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => confirmDelete && handleDelete(confirmDelete)}
                            disabled={deleteStatus === "loading"}
                        >
                            Delete
                        </Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
