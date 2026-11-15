/**
 * Whether `text` is a full http or https address: the scheme (in any letter case), `//`, and a host that does not start
 * with a slash or a blank. The one check for an address a client is handed to load as a picture; any other kind of value
 * (`native:`, `file:`, `javascript:`, a path, no scheme) is not one. It does not parse the address: a caller that stores
 * one also builds a `URL` from it.
 */
export const isWebAddress = (text: string): boolean => /^https?:\/\/[^/\s]/i.test(text);
