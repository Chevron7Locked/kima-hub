"use client";

import { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
import { SettingsSection, SettingsInput, SettingsSelect } from "../ui";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface User {
    id: string;
    username: string;
    role: "user" | "admin";
    createdAt: string;
}

export function UserManagementSection() {
    const { user: currentUser } = useAuth();
    const [users, setUsers] = useState<User[]>([]);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<"user" | "admin">("user");
    const [creating, setCreating] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [createStatus, setCreateStatus] = useState<StatusType>("idle");
    const [createMessage, setCreateMessage] = useState("");
    const [deleteStatus, setDeleteStatus] = useState<StatusType>("idle");
    const [deleteMessage, setDeleteMessage] = useState("");

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        try {
            setLoading(true);
            const data = await api.get<User[]>("/auth/users");
            setUsers(data);
        } catch (error) {
            console.error("Failed to load users:", error);
        } finally {
            setLoading(false);
        }
    };

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
                username: newUsername,
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

    const handleDelete = async (userId: string) => {
        setDeleteStatus("loading");
        try {
            await api.delete(`/auth/users/${userId}`);
            setDeleteStatus("success");
            setDeleteMessage("Deleted");
            setConfirmDelete(null);
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
                {/* Create User Form */}
                <div className="py-4 px-4 bg-white/5 rounded-lg border border-white/10 mb-4">
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
                            <button
                                onClick={handleCreate}
                                disabled={creating || !newUsername.trim() || newPassword.length < 6}
                                className="px-4 py-1.5 text-xs font-semibold bg-brand text-black rounded-lg
                                    hover:bg-[#f97316] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {creating ? "Creating..." : "Create"}
                            </button>
                            <InlineStatus
                                status={createStatus}
                                message={createMessage}
                                onClear={() => setCreateStatus("idle")}
                            />
                        </div>
                    </div>
                </div>

                {/* Users List */}
                <div className="space-y-1">
                    {loading ? (
                        <div className="py-4 text-xs text-[var(--text-muted)]">Loading users...</div>
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
                                        onClick={() => setConfirmDelete(user.id)}
                                        className="p-2 text-[var(--text-muted)] hover:text-red-400 transition-colors"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </SettingsSection>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!confirmDelete}
                onClose={() => setConfirmDelete(null)}
                title="Delete User"
            >
                <div className="space-y-4">
                    <p className="text-xs text-[var(--text-secondary)]">
                        Are you sure you want to delete this user? This action cannot be undone.
                    </p>
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={deleteStatus}
                            message={deleteMessage}
                            onClear={() => setDeleteStatus("idle")}
                        />
                        <button
                            onClick={() => setConfirmDelete(null)}
                            className="px-4 py-2 text-xs text-[var(--text-muted)] hover:text-white/70 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => confirmDelete && handleDelete(confirmDelete)}
                            className="px-4 py-2 text-xs font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
