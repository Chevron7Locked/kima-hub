"use client";

import { useState, useEffect } from "react";
import { Trash2, KeyRound, Pencil } from "lucide-react";
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
    const [resetTarget, setResetTarget] = useState<User | null>(null);
    const [resetPassword, setResetPassword] = useState("");
    const [resetStatus, setResetStatus] = useState<StatusType>("idle");
    const [resetMessage, setResetMessage] = useState("");
    const [editTarget, setEditTarget] = useState<User | null>(null);
    const [editUsername, setEditUsername] = useState("");
    const [editRole, setEditRole] = useState<"user" | "admin">("user");
    const [editStatus, setEditStatus] = useState<StatusType>("idle");
    const [editMessage, setEditMessage] = useState("");

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

    const openReset = (user: User) => {
        setResetTarget(user);
        setResetPassword("");
        setResetStatus("idle");
        setResetMessage("");
    };

    const handleResetPassword = async () => {
        if (!resetTarget || resetPassword.length < 6) {
            setResetStatus("error");
            setResetMessage("Password 6+ chars");
            return;
        }
        setResetStatus("loading");
        try {
            await api.post(`/auth/users/${resetTarget.id}/reset-password`, {
                newPassword: resetPassword,
            });
            setResetStatus("success");
            setResetMessage("Password reset");
            setResetPassword("");
            // brief pause so the success state is visible before closing
            setTimeout(() => setResetTarget(null), 800);
        } catch (error: unknown) {
            setResetStatus("error");
            setResetMessage(error instanceof Error ? error.message : "Failed");
        }
    };

    const openEdit = (user: User) => {
        setEditTarget(user);
        setEditUsername(user.username);
        setEditRole(user.role);
        setEditStatus("idle");
        setEditMessage("");
    };

    const handleEdit = async () => {
        if (!editTarget) return;
        const trimmed = editUsername.trim();
        if (!trimmed) {
            setEditStatus("error");
            setEditMessage("Username required");
            return;
        }
        if (trimmed === editTarget.username && editRole === editTarget.role) {
            setEditTarget(null);
            return;
        }
        setEditStatus("loading");
        try {
            await api.patch(`/auth/users/${editTarget.id}`, {
                username: trimmed,
                role: editRole,
            });
            setEditStatus("success");
            setEditMessage("Saved");
            setTimeout(() => setEditTarget(null), 800);
            loadUsers();
        } catch (error: unknown) {
            setEditStatus("error");
            setEditMessage(error instanceof Error ? error.message : "Failed");
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
                    <h3 className="text-xs font-mono text-white/50 mb-3 uppercase tracking-wider">Create New User</h3>
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
                                className="px-4 py-1.5 text-xs font-black bg-brand text-black rounded-lg uppercase tracking-wider
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
                        <div className="py-4 text-xs font-mono text-white/30 uppercase tracking-wider">Loading users...</div>
                    ) : users.length === 0 ? (
                        <div className="py-4 text-xs font-mono text-white/30 uppercase tracking-wider">No users found</div>
                    ) : (
                        users.map((user) => (
                            <div
                                key={user.id}
                                className="flex items-center justify-between py-3 px-3 rounded-lg hover:bg-white/[0.03] border border-transparent hover:border-white/5 transition-all"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-xs font-black text-brand">
                                        {user.username[0].toUpperCase()}
                                    </div>
                                    <div>
                                        <div className="text-sm font-medium text-white">
                                            {user.username}
                                            {currentUser?.id === user.id && (
                                                <span className="text-[10px] font-mono text-white/30 ml-2 uppercase tracking-wider">(you)</span>
                                            )}
                                        </div>
                                        <div className="text-[10px] font-mono text-white/30 uppercase tracking-wider">
                                            {user.role === "admin" ? "Admin" : "User"}
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => openEdit(user)}
                                        title="Edit username / role"
                                        className="p-2 text-white/20 hover:text-white transition-colors"
                                    >
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => openReset(user)}
                                        title="Reset password"
                                        className="p-2 text-white/20 hover:text-brand transition-colors"
                                    >
                                        <KeyRound className="w-4 h-4" />
                                    </button>
                                    {currentUser?.id !== user.id && (
                                        <button
                                            onClick={() => setConfirmDelete(user.id)}
                                            title="Delete user"
                                            className="p-2 text-white/20 hover:text-red-400 transition-colors"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
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
                    <p className="text-xs font-mono text-white/50 uppercase tracking-wider">
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
                            className="px-4 py-2 text-xs font-mono text-white/40 hover:text-white/70 uppercase tracking-wider transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => confirmDelete && handleDelete(confirmDelete)}
                            className="px-4 py-2 text-xs font-black bg-red-500 text-white rounded-lg uppercase tracking-wider hover:bg-red-600 transition-colors"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Reset Password Modal */}
            <Modal
                isOpen={!!resetTarget}
                onClose={() => setResetTarget(null)}
                title={`Reset Password${resetTarget ? ` — ${resetTarget.username}` : ""}`}
            >
                <div className="space-y-4">
                    <p className="text-xs font-mono text-white/50 uppercase tracking-wider">
                        Set a new password for this user. Their existing sessions will be
                        signed out.
                        {resetTarget && currentUser?.id === resetTarget.id && (
                            <span className="block mt-2 text-amber-400/70">
                                This is your own account — you&apos;ll be logged out.
                            </span>
                        )}
                    </p>
                    <SettingsInput
                        type="password"
                        value={resetPassword}
                        onChange={setResetPassword}
                        placeholder="New password (6+ chars)"
                        className="w-full"
                    />
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={resetStatus}
                            message={resetMessage}
                            onClear={() => setResetStatus("idle")}
                        />
                        <button
                            onClick={() => setResetTarget(null)}
                            className="px-4 py-2 text-xs font-mono text-white/40 hover:text-white/70 uppercase tracking-wider transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleResetPassword}
                            disabled={resetStatus === "loading" || resetPassword.length < 6}
                            className="px-4 py-2 text-xs font-black bg-brand text-black rounded-lg uppercase tracking-wider hover:bg-[#f97316] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {resetStatus === "loading" ? "Resetting..." : "Reset Password"}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Edit User Modal */}
            <Modal
                isOpen={!!editTarget}
                onClose={() => setEditTarget(null)}
                title={`Edit User${editTarget ? ` — ${editTarget.username}` : ""}`}
            >
                <div className="space-y-4">
                    <div>
                        <label className="block text-[10px] font-mono text-white/40 mb-1 uppercase tracking-wider">
                            Username
                        </label>
                        <SettingsInput
                            value={editUsername}
                            onChange={setEditUsername}
                            placeholder="Username"
                            className="w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] font-mono text-white/40 mb-1 uppercase tracking-wider">
                            Role
                        </label>
                        <SettingsSelect
                            value={editRole}
                            onChange={(v) => setEditRole(v as "user" | "admin")}
                            options={[
                                { value: "user", label: "User" },
                                { value: "admin", label: "Admin" },
                            ]}
                        />
                    </div>
                    {editTarget && currentUser?.id === editTarget.id && editRole !== "admin" && (
                        <p className="text-xs font-mono text-amber-400/70 uppercase tracking-wider">
                            ⚠ Demoting yourself will remove your admin access.
                        </p>
                    )}
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={editStatus}
                            message={editMessage}
                            onClear={() => setEditStatus("idle")}
                        />
                        <button
                            onClick={() => setEditTarget(null)}
                            className="px-4 py-2 text-xs font-mono text-white/40 hover:text-white/70 uppercase tracking-wider transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleEdit}
                            disabled={editStatus === "loading" || !editUsername.trim()}
                            className="px-4 py-2 text-xs font-black bg-brand text-black rounded-lg uppercase tracking-wider hover:bg-[#f97316] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {editStatus === "loading" ? "Saving..." : "Save"}
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
