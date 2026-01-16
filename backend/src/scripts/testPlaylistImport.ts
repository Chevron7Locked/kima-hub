/**
 * Test script for playlist import with album resolution
 *
 * Usage:
 *   npx ts-node src/scripts/testPlaylistImport.ts <spotify-playlist-url>
 *
 * Example:
 *   npx ts-node src/scripts/testPlaylistImport.ts https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
 */

import { spotifyImportService } from '../services/spotifyImport';

async function testPlaylistImport() {
    const playlistUrl = process.argv[2];

    if (!playlistUrl) {
        console.log('Usage: npx ts-node src/scripts/testPlaylistImport.ts <spotify-playlist-url>');
        console.log('Example: npx ts-node src/scripts/testPlaylistImport.ts https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('PLAYLIST IMPORT TEST');
    console.log('='.repeat(60));
    console.log(`\nTesting: ${playlistUrl}\n`);

    try {
        console.log('Step 1: Generating import preview...\n');
        const preview = await spotifyImportService.generatePreview(playlistUrl);

        console.log('='.repeat(60));
        console.log('RESULTS');
        console.log('='.repeat(60));

        console.log(`\nPlaylist: ${preview.playlist.name}`);
        console.log(`Total tracks: ${preview.summary.total}`);
        console.log(`In library: ${preview.summary.inLibrary}`);
        console.log(`Downloadable: ${preview.summary.downloadable}`);
        console.log(`Not found: ${preview.summary.notFound}`);

        const unknownAlbumTracks = preview.matchedTracks.filter(
            m => m.spotifyTrack.album === 'Unknown Album'
        );
        console.log(`\nTracks with Unknown Album: ${unknownAlbumTracks.length}`);

        if (unknownAlbumTracks.length > 0) {
            console.log('\nTracks still with Unknown Album:');
            unknownAlbumTracks.slice(0, 10).forEach(m => {
                console.log(`  - "${m.spotifyTrack.title}" by ${m.spotifyTrack.artist}`);
            });
            if (unknownAlbumTracks.length > 10) {
                console.log(`  ... and ${unknownAlbumTracks.length - 10} more`);
            }
        }

        console.log(`\nAlbums to download: ${preview.albumsToDownload.length}`);
        preview.albumsToDownload.slice(0, 10).forEach(album => {
            const mbidStatus = album.albumMbid
                ? `MBID: ${album.albumMbid.substring(0, 8)}...`
                : 'NO MBID';
            console.log(`  - ${album.artistName} - "${album.albumName}" (${album.trackCount} tracks) [${mbidStatus}]`);
        });
        if (preview.albumsToDownload.length > 10) {
            console.log(`  ... and ${preview.albumsToDownload.length - 10} more albums`);
        }

        console.log('\n' + '='.repeat(60));
        console.log('VERDICT');
        console.log('='.repeat(60));

        const unknownPercentage = preview.summary.total > 0
            ? (unknownAlbumTracks.length / preview.summary.total) * 100
            : 0;

        if (unknownPercentage === 0) {
            console.log('\nSUCCESS: All albums resolved!');
        } else if (unknownPercentage < 5) {
            console.log(`\nGOOD: Only ${unknownPercentage.toFixed(1)}% tracks have Unknown Album`);
        } else if (unknownPercentage < 20) {
            console.log(`\nFAIR: ${unknownPercentage.toFixed(1)}% tracks have Unknown Album`);
        } else {
            console.log(`\nNEEDS WORK: ${unknownPercentage.toFixed(1)}% tracks have Unknown Album`);
        }

    } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('\nError:', errorMsg);
        process.exit(1);
    }
}

testPlaylistImport().catch(console.error);
