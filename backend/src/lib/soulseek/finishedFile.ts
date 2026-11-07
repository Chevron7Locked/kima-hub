import fs from 'fs'
import path from 'path'

export type FinishedFile = { found: true; path: string } | { found: false; reason: 'outside' | 'missing' }

/**
 * Finds the finished copy of a peer's file under slskd's downloads folder. The peer chooses the name, so a name that
 * could lead anywhere but inside the folder is refused rather than tried against a shorter ending.
 */
export async function findFinishedFile(downloadsRoot: string, peerName: string): Promise<FinishedFile> {
  const parts = peerName.replace(/\\/g, '/').split('/')
  if (parts.includes('..')) return { found: false, reason: 'outside' }

  let realRoot: string
  try {
    realRoot = await fs.promises.realpath(downloadsRoot)
  } catch {
    return { found: false, reason: 'missing' }
  }

  for (let i = 0; i < parts.length; i++) {
    const candidate = path.join(downloadsRoot, ...parts.slice(i))
    let real: string
    try {
      real = await fs.promises.realpath(candidate)
      await fs.promises.access(real, fs.constants.R_OK)
    } catch {
      continue
    }
    if (real === realRoot) continue
    if (!real.startsWith(realRoot + path.sep)) return { found: false, reason: 'outside' }
    if (!(await fs.promises.stat(real)).isFile()) continue
    return { found: true, path: real }
  }

  const found = await walkFor(realRoot, parts[parts.length - 1])
  return found ? { found: true, path: found } : { found: false, reason: 'missing' }
}

/** Looks for a regular file of this name under a folder. Links are not followed, so the walk stays inside it. */
async function walkFor(dir: string, name: string): Promise<string | null> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isFile() && e.name === name) return full
    if (e.isDirectory()) {
      const found = await walkFor(full, name)
      if (found) return found
    }
  }
  return null
}
