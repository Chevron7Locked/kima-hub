/**
 * Artist Normalization Test Suite
 * 
 * Tests the artist name normalization utilities to verify:
 * 1. Hip-hop collaborations: "Ric Wilson x Chromeo x A-Trak" → "Ric Wilson"
 * 2. Featured artists stripped: "Artist feat. Someone" → "Artist"
 * 3. Band names preserved: "Of Mice & Men", "Between the Buried and Me"
 * 4. Empty string validation: Never returns empty, returns "Unknown Artist"
 * 5. Orchestra collaborations: "Philip Glass, Atlanta Symphony Orchestra" → "Philip Glass"
 * 6. Folder fallback: "Paramore - After Laughter (2017) FLAC" → "Paramore"
 * 
 * Run with: npx tsx src/tests/artistNormalization.test.ts
 */

import {
    extractPrimaryArtist,
    parseArtistFromPath,
    normalizeArtistName,
    canonicalizeVariousArtists,
    areArtistNamesSimilar,
} from "../utils/artistNormalization";

interface TestCase {
    name: string;
    input: string;
    expected: string;
    func: (input: string) => string | null;
}

// Test cases for extractPrimaryArtist
const extractPrimaryArtistTests: TestCase[] = [
    // Hip-hop collaborations with " x "
    {
        name: "Hip-hop collaboration: Artist x Artist x Artist",
        input: "Ric Wilson x Chromeo x A-Trak",
        expected: "Ric Wilson",
        func: extractPrimaryArtist,
    },
    {
        name: "Hip-hop collaboration: Artist x Artist",
        input: "Artist A x Artist B",
        expected: "Artist A",
        func: extractPrimaryArtist,
    },
    
    // Featured artists
    {
        name: "Featured artist: feat.",
        input: "Artist feat. Someone",
        expected: "Artist",
        func: extractPrimaryArtist,
    },
    {
        name: "Featured artist: feat (no dot)",
        input: "Artist feat Someone",
        expected: "Artist",
        func: extractPrimaryArtist,
    },
    {
        name: "Featured artist: ft.",
        input: "Artist ft. Someone",
        expected: "Artist",
        func: extractPrimaryArtist,
    },
    {
        name: "Featured artist: ft (no dot)",
        input: "Artist ft Someone",
        expected: "Artist",
        func: extractPrimaryArtist,
    },
    {
        name: "Featured artist: featuring",
        input: "Artist featuring Guest",
        expected: "Artist",
        func: extractPrimaryArtist,
    },
    
    // Band name preservation
    {
        name: "Band name: Of Mice & Men (preserved)",
        input: "Of Mice & Men",
        expected: "Of Mice & Men",
        func: extractPrimaryArtist,
    },
    {
        name: "Band name: Between the Buried and Me (preserved)",
        input: "Between the Buried and Me",
        expected: "Between the Buried and Me",
        func: extractPrimaryArtist,
    },
    {
        name: "Band name: Coheed and Cambria (preserved)",
        input: "Coheed and Cambria",
        expected: "Coheed and Cambria",
        func: extractPrimaryArtist,
    },
    {
        name: "Band name: The Naked and Famous (preserved)",
        input: "The Naked and Famous",
        expected: "The Naked and Famous",
        func: extractPrimaryArtist,
    },
    {
        name: "Band name: Earth, Wind & Fire (preserved)",
        input: "Earth, Wind & Fire",
        expected: "Earth, Wind & Fire",
        func: extractPrimaryArtist,
    },
    
    // Collaborations that should split
    {
        name: "Collaboration: CHVRCHES & Robert Smith",
        input: "CHVRCHES & Robert Smith",
        expected: "CHVRCHES",
        func: extractPrimaryArtist,
    },
    
    // Orchestra collaborations
    {
        name: "Orchestra collaboration: Philip Glass, Atlanta Symphony Orchestra",
        input: "Philip Glass, Atlanta Symphony Orchestra",
        expected: "Philip Glass",
        func: extractPrimaryArtist,
    },
    {
        name: "Orchestra collaboration: Yo-Yo Ma, New York Philharmonic",
        input: "Yo-Yo Ma, New York Philharmonic",
        expected: "Yo-Yo Ma",
        func: extractPrimaryArtist,
    },
    
    // Edge cases: Empty strings
    {
        name: "Empty string returns Unknown Artist",
        input: "",
        expected: "Unknown Artist",
        func: extractPrimaryArtist,
    },
    {
        name: "Whitespace-only returns Unknown Artist",
        input: "   ",
        expected: "Unknown Artist",
        func: extractPrimaryArtist,
    },
    
    // No collaboration - returns as-is
    {
        name: "Single artist: Radiohead (preserved)",
        input: "Radiohead",
        expected: "Radiohead",
        func: extractPrimaryArtist,
    },
    {
        name: "Single artist with article: The Beatles (preserved)",
        input: "The Beatles",
        expected: "The Beatles",
        func: extractPrimaryArtist,
    },
];

// Test cases for parseArtistFromPath
const parseArtistFromPathTests: TestCase[] = [
    {
        name: "Folder pattern: Artist - Album (Year) FLAC",
        input: "Paramore - After Laughter (2017) FLAC",
        expected: "Paramore",
        func: parseArtistFromPath as (input: string) => string,
    },
    {
        name: "Folder pattern: Artist - Album",
        input: "Radiohead - OK Computer",
        expected: "Radiohead",
        func: parseArtistFromPath as (input: string) => string,
    },
    {
        name: "Folder pattern: Artist - Album (Year)",
        input: "The Beatles - Abbey Road (1969)",
        expected: "The Beatles",
        func: parseArtistFromPath as (input: string) => string,
    },
    {
        name: "Scene release format: Artist-Album.Name-FLAC-YEAR",
        input: "Paramore-After.Laughter-FLAC-2017",
        expected: "Paramore",
        func: parseArtistFromPath as (input: string) => string,
    },
];

// Test cases for Various Artists canonicalization
const variousArtistsTests: TestCase[] = [
    {
        name: "VA → Various Artists",
        input: "VA",
        expected: "Various Artists",
        func: canonicalizeVariousArtists,
    },
    {
        name: "V.A. → Various Artists",
        input: "V.A.",
        expected: "Various Artists",
        func: canonicalizeVariousArtists,
    },
    {
        name: "V/A → Various Artists",
        input: "V/A",
        expected: "Various Artists",
        func: canonicalizeVariousArtists,
    },
    {
        name: "Various → Various Artists",
        input: "Various",
        expected: "Various Artists",
        func: canonicalizeVariousArtists,
    },
    {
        name: "Various Artist → Various Artists",
        input: "Various Artist",
        expected: "Various Artists",
        func: canonicalizeVariousArtists,
    },
    {
        name: "<Various Artists> → Various Artists",
        input: "<Various Artists>",
        expected: "Various Artists",
        func: canonicalizeVariousArtists,
    },
    {
        name: "Normal artist preserved",
        input: "Daft Punk",
        expected: "Daft Punk",
        func: canonicalizeVariousArtists,
    },
];

// Test cases for normalizeArtistName
const normalizeArtistNameTests: TestCase[] = [
    {
        name: "Lowercase: RADIOHEAD → radiohead",
        input: "RADIOHEAD",
        expected: "radiohead",
        func: normalizeArtistName,
    },
    {
        name: "Diacritics: Ólafur Arnalds → olafur arnalds",
        input: "Ólafur Arnalds",
        expected: "olafur arnalds",
        func: normalizeArtistName,
    },
    {
        name: "Ampersand: Of Mice & Men → of mice and men",
        input: "Of Mice & Men",
        expected: "of mice and men",
        func: normalizeArtistName,
    },
    {
        name: "Multiple spaces collapsed",
        input: "The    Beatles",
        expected: "the beatles",
        func: normalizeArtistName,
    },
];

function runTests(): void {
    console.log("\n" + "=".repeat(70));
    console.log("ARTIST NORMALIZATION TEST SUITE");
    console.log("=".repeat(70));

    let totalPassed = 0;
    let totalFailed = 0;

    // Run extractPrimaryArtist tests
    console.log("\n📌 extractPrimaryArtist() Tests");
    console.log("-".repeat(70));
    for (const test of extractPrimaryArtistTests) {
        const result = test.func(test.input);
        const passed = result === test.expected;
        
        if (passed) {
            console.log(`✅ PASS: ${test.name}`);
            totalPassed++;
        } else {
            console.log(`❌ FAIL: ${test.name}`);
            console.log(`   Input:    "${test.input}"`);
            console.log(`   Expected: "${test.expected}"`);
            console.log(`   Got:      "${result}"`);
            totalFailed++;
        }
    }

    // Run parseArtistFromPath tests
    console.log("\n📂 parseArtistFromPath() Tests");
    console.log("-".repeat(70));
    for (const test of parseArtistFromPathTests) {
        const result = test.func(test.input);
        const passed = result === test.expected;
        
        if (passed) {
            console.log(`✅ PASS: ${test.name}`);
            totalPassed++;
        } else {
            console.log(`❌ FAIL: ${test.name}`);
            console.log(`   Input:    "${test.input}"`);
            console.log(`   Expected: "${test.expected}"`);
            console.log(`   Got:      "${result}"`);
            totalFailed++;
        }
    }

    // Run Various Artists tests
    console.log("\n🎭 canonicalizeVariousArtists() Tests");
    console.log("-".repeat(70));
    for (const test of variousArtistsTests) {
        const result = test.func(test.input);
        const passed = result === test.expected;
        
        if (passed) {
            console.log(`✅ PASS: ${test.name}`);
            totalPassed++;
        } else {
            console.log(`❌ FAIL: ${test.name}`);
            console.log(`   Input:    "${test.input}"`);
            console.log(`   Expected: "${test.expected}"`);
            console.log(`   Got:      "${result}"`);
            totalFailed++;
        }
    }

    // Run normalizeArtistName tests
    console.log("\n🔤 normalizeArtistName() Tests");
    console.log("-".repeat(70));
    for (const test of normalizeArtistNameTests) {
        const result = test.func(test.input);
        const passed = result === test.expected;
        
        if (passed) {
            console.log(`✅ PASS: ${test.name}`);
            totalPassed++;
        } else {
            console.log(`❌ FAIL: ${test.name}`);
            console.log(`   Input:    "${test.input}"`);
            console.log(`   Expected: "${test.expected}"`);
            console.log(`   Got:      "${result}"`);
            totalFailed++;
        }
    }

    // Run areArtistNamesSimilar tests
    console.log("\n🔍 areArtistNamesSimilar() Tests");
    console.log("-".repeat(70));
    
    const similarityTests = [
        { name1: "Ólafur Arnalds", name2: "Olafur Arnalds", expected: true },
        { name1: "Of Mice & Men", name2: "Of Mice And Men", expected: true },
        { name1: "The Weeknd", name2: "The Weekend", expected: true },
        { name1: "Radiohead", name2: "Coldplay", expected: false },
    ];

    for (const test of similarityTests) {
        const result = areArtistNamesSimilar(test.name1, test.name2);
        const passed = result === test.expected;
        
        if (passed) {
            console.log(`✅ PASS: "${test.name1}" ≈ "${test.name2}" → ${result}`);
            totalPassed++;
        } else {
            console.log(`❌ FAIL: "${test.name1}" ≈ "${test.name2}"`);
            console.log(`   Expected: ${test.expected}`);
            console.log(`   Got:      ${result}`);
            totalFailed++;
        }
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("TEST RESULTS SUMMARY");
    console.log("=".repeat(70));
    console.log(`Total: ${totalPassed + totalFailed} tests`);
    console.log(`Passed: ${totalPassed}`);
    console.log(`Failed: ${totalFailed}`);
    
    if (totalFailed === 0) {
        console.log("\n🎉 ALL TESTS PASSED! Artist normalization is working correctly.");
    } else {
        console.log("\n💥 SOME TESTS FAILED. Review the output above for details.");
    }

    process.exit(totalFailed > 0 ? 1 : 0);
}

// Run tests
runTests();
