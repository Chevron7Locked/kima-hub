/**
 * LDAP authentication service tests
 *
 * These tests mock the `ldapts` Client to exercise success, failure, invalid
 * credentials, ambiguous search results, and disabled LDAP paths without
 * requiring a real directory server.
 */

jest.mock("ldapts");

import { Client } from "ldapts";
import { authenticateLdapUser, buildUserFilter } from "../ldapAuth";

const MockedClient = jest.mocked(Client);

describe("buildUserFilter", () => {
    it("substitutes the username into the filter template", () => {
        process.env.LDAP_USER_FILTER = "(uid={username})";
        expect(buildUserFilter("testuser")).toBe("(uid=testuser)");
    });

    it("escapes special LDAP characters", () => {
        process.env.LDAP_USER_FILTER = "(uid={username})";
        expect(buildUserFilter("user*name")).toBe("(uid=user\\*name)");
    });
});

describe("authenticateLdapUser", () => {
    const bindMock = jest.fn();
    const searchMock = jest.fn();
    const unbindMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        // Default environment: LDAP enabled with minimal config
        process.env.LDAP_ENABLED = "true";
        process.env.LDAP_URL = "ldap://192.168.68.71:3890";
        process.env.LDAP_BIND_DN = "uid=admin,ou=people,dc=headoverhalls,dc=net";
        process.env.LDAP_BIND_PASSWORD = "admin-secret";
        process.env.LDAP_BASE_DN = "ou=people,dc=headoverhalls,dc=net";
        process.env.LDAP_USER_FILTER = "(uid={username})";
        process.env.LDAP_USERNAME_ATTRIBUTE = "uid";
        process.env.LDAP_DEFAULT_ROLE = "user";

        MockedClient.mockImplementation(() => {
            return {
                bind: bindMock,
                search: searchMock,
                unbind: unbindMock,
            } as unknown as Client;
        });
    });

    afterAll(() => {
        delete process.env.LDAP_ENABLED;
        delete process.env.LDAP_URL;
        delete process.env.LDAP_BIND_DN;
        delete process.env.LDAP_BIND_PASSWORD;
        delete process.env.LDAP_BASE_DN;
        delete process.env.LDAP_USER_FILTER;
        delete process.env.LDAP_USERNAME_ATTRIBUTE;
        delete process.env.LDAP_DEFAULT_ROLE;
    });

    it("returns success with profile on valid credentials", async () => {
        bindMock
            .mockResolvedValueOnce(undefined) // service bind
            .mockResolvedValueOnce(undefined); // user bind

        searchMock.mockResolvedValue({
            searchEntries: [
                {
                    dn: "uid=testuser,ou=people,dc=headoverhalls,dc=net",
                    uid: "testuser",
                    displayName: "Test User",
                    mail: "test@example.com",
                },
            ],
        });

        const result = await authenticateLdapUser("testuser", "testing123");

        expect(result.success).toBe(true);
        expect(result.profile).toEqual({
            username: "testuser",
            dn: "uid=testuser,ou=people,dc=headoverhalls,dc=net",
            displayName: "Test User",
            email: "test@example.com",
        });
        expect(bindMock).toHaveBeenNthCalledWith(
            1,
            "uid=admin,ou=people,dc=headoverhalls,dc=net",
            "admin-secret"
        );
        expect(bindMock).toHaveBeenNthCalledWith(
            2,
            "uid=testuser,ou=people,dc=headoverhalls,dc=net",
            "testing123"
        );
    });

    it("returns failure when user is not found", async () => {
        bindMock.mockResolvedValueOnce(undefined);
        searchMock.mockResolvedValue({ searchEntries: [] });

        const result = await authenticateLdapUser("unknown", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("User not found");
    });

    it("returns failure when user bind rejects the password", async () => {
        bindMock
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("Invalid credentials"));

        searchMock.mockResolvedValue({
            searchEntries: [
                {
                    dn: "uid=testuser,ou=people,dc=headoverhalls,dc=net",
                    uid: "testuser",
                },
            ],
        });

        const result = await authenticateLdapUser("testuser", "wrongpassword");

        expect(result.success).toBe(false);
        expect(result.error).toBe("LDAP authentication failed");
    });

    it("returns failure when search returns ambiguous results", async () => {
        bindMock.mockResolvedValueOnce(undefined);
        searchMock.mockResolvedValue({
            searchEntries: [
                { dn: "uid=testuser,ou=people,dc=headoverhalls,dc=net", uid: "testuser" },
                { dn: "uid=testuser2,ou=people,dc=headoverhalls,dc=net", uid: "testuser2" },
            ],
        });

        const result = await authenticateLdapUser("testuser", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Ambiguous user search result");
    });

    it("returns failure when LDAP is disabled", async () => {
        process.env.LDAP_ENABLED = "false";

        const result = await authenticateLdapUser("testuser", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("LDAP is not enabled");
        expect(MockedClient).not.toHaveBeenCalled();
    });

    it("returns failure when service account bind fails", async () => {
        bindMock.mockRejectedValueOnce(new Error("Service bind failed"));

        const result = await authenticateLdapUser("testuser", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("LDAP authentication failed");
    });

    it("unbinds both clients even on failure", async () => {
        bindMock.mockRejectedValueOnce(new Error("Service bind failed"));

        await authenticateLdapUser("testuser", "password");

        expect(unbindMock).toHaveBeenCalledTimes(1);
    });
});
