export function mapSubsonicUser(user: { username: string; role: string }) {
    return {
        "@_username": user.username,
        "@_scrobblingEnabled": true,
        "@_adminRole": user.role === "admin",
        "@_settingsRole": true,
        "@_downloadRole": true,
        "@_uploadRole": false,
        "@_playlistRole": true,
        "@_coverArtRole": false,
        "@_commentRole": false,
        "@_podcastRole": false,
        "@_streamRole": true,
        "@_jukeboxRole": false,
        "@_shareRole": false,
        folder: [1],
    };
}

export function decodeSubsonicPassword(raw: string): string {
    if (raw.startsWith("enc:")) {
        const hex = raw.slice(4);
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
            return Buffer.from(hex, "hex").toString("utf8");
        }
    }
    return raw;
}