/**
 * CJS mock for music-metadata (pure ESM, incompatible with Jest's CJS runner).
 * Returns minimal format data; tests that need specific values should
 * override with jest.spyOn or mockResolvedValue on the named export.
 */
const parseFile = jest.fn().mockResolvedValue({ format: { bitrate: null } });
const parseBuffer = jest.fn().mockResolvedValue({ format: {} });

module.exports = { parseFile, parseBuffer };
module.exports.default = module.exports;
