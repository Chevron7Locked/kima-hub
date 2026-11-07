import fs from 'fs'
import os from 'os'
import path from 'path'

import { findFinishedFile } from '../finishedFile'

let base: string
let root: string

beforeEach(async () => {
  base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'finished-file-')))
  root = path.join(base, 'downloads')
  await fs.promises.mkdir(root)
})

afterEach(async () => {
  await fs.promises.rm(base, { recursive: true, force: true })
})

async function put(file: string, contents = 'x'): Promise<string> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, contents)
  return file
}

describe('a normal finished download', () => {
  it('is found at the path the peer named', async () => {
    const file = await put(path.join(root, 'Artist', 'Album', '01 - Song.flac'))
    expect(await findFinishedFile(root, 'Artist/Album/01 - Song.flac')).toEqual({ found: true, path: file })
  })
})

describe('a name with a .. part', () => {
  it.each([
    ['../secret.flac'],
    ['..\\secret.flac'],
    ['Artist/../../secret.flac'],
    ['@@peer\\Music\\..\\..\\secret.flac'],
  ])('%s is refused, though it reaches a real file outside the folder', async (name) => {
    await put(path.join(base, 'secret.flac'), 'private')
    expect(await findFinishedFile(root, name)).toEqual({ found: false, reason: 'outside' })
  })
})

describe('a name that only contains dots', () => {
  it.each([
    ['Album.../01 - Song.flac'],
    ['Artist/..intro.flac'],
    ['Vol. 1../02 - Song.flac'],
    ['Artist\\Live..\\..hidden.flac'],
  ])('%s is still found', async (name) => {
    const real = await put(path.join(root, ...name.split(/[\\/]/)))
    expect(await findFinishedFile(root, name)).toEqual({ found: true, path: real })
  })
})

describe('a candidate that leads outside the folder through a link', () => {
  it('a file link pointing at a real file outside is refused', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await fs.promises.mkdir(path.join(root, 'Artist'))
    await fs.promises.symlink(secret, path.join(root, 'Artist', 'song.flac'))
    expect(await findFinishedFile(root, 'Artist/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('a folder link pointing outside is refused', async () => {
    await put(path.join(base, 'elsewhere', 'song.flac'), 'private')
    await fs.promises.symlink(path.join(base, 'elsewhere'), path.join(root, 'Linked'))
    expect(await findFinishedFile(root, 'Linked/song.flac')).toEqual({ found: false, reason: 'outside' })
  })
})

describe('what counts as inside the folder', () => {
  it('a sibling folder that shares the folder name as a prefix is outside', async () => {
    await put(`${root}-evil/song.flac`, 'private')
    await fs.promises.symlink(`${root}-evil`, path.join(root, 'link'))
    expect(await findFinishedFile(root, 'link/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('a link that stays inside the folder gives the real path of the file', async () => {
    const real = await put(path.join(root, 'Real', 'song.flac'))
    await fs.promises.symlink(real, path.join(root, 'alias.flac'))
    expect(await findFinishedFile(root, 'alias.flac')).toEqual({ found: true, path: real })
  })

  it('a downloads folder that is itself a link is judged by where it really is', async () => {
    const realFolder = path.join(base, 'real-downloads')
    const file = await put(path.join(realFolder, 'Artist', 'song.flac'))
    const linked = path.join(base, 'linked-downloads')
    await fs.promises.symlink(realFolder, linked)
    expect(await findFinishedFile(linked, 'Artist/song.flac')).toEqual({ found: true, path: file })
  })

  it('the folder itself is not a finished file', async () => {
    expect(await findFinishedFile(root, '.')).toEqual({ found: false, reason: 'missing' })
    expect(await findFinishedFile(root, '')).toEqual({ found: false, reason: 'missing' })
  })

  it('a folder is not a finished file', async () => {
    await fs.promises.mkdir(path.join(root, 'Artist', 'Album'), { recursive: true })
    expect(await findFinishedFile(root, 'Artist/Album')).toEqual({ found: false, reason: 'missing' })
  })

  it('a missing file is reported as missing', async () => {
    expect(await findFinishedFile(root, 'Artist/none.flac')).toEqual({ found: false, reason: 'missing' })
  })
})

describe('a finished download found by its file name alone', () => {
  it('is found under any folder inside the downloads folder', async () => {
    const real = await put(path.join(root, 'Deep', 'Nested', 'song.flac'))
    expect(await findFinishedFile(root, '@@peer\\Music\\Other\\song.flac')).toEqual({ found: true, path: real })
  })

  it('does not follow a folder link out of the downloads folder', async () => {
    await put(path.join(base, 'elsewhere', 'song.flac'), 'private')
    await fs.promises.symlink(path.join(base, 'elsewhere'), path.join(root, 'Linked'))
    expect(await findFinishedFile(root, 'Nope/song.flac')).toEqual({ found: false, reason: 'missing' })
  })

  it('a file link carrying the same name is refused, not skipped', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await fs.promises.symlink(secret, path.join(root, 'song.flac'))
    expect(await findFinishedFile(root, 'Nope/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('does not take a file link deeper down as the match', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await fs.promises.mkdir(path.join(root, 'Deep'))
    await fs.promises.symlink(secret, path.join(root, 'Deep', 'other.flac'))
    expect(await findFinishedFile(root, 'Nope/other.flac')).toEqual({ found: false, reason: 'missing' })
  })
})

describe('a refused name', () => {
  it('does not fall back to a shorter ending of the same name', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await put(path.join(root, 'song.flac'))
    await fs.promises.mkdir(path.join(root, 'b'))
    await fs.promises.symlink(secret, path.join(root, 'b', 'song.flac'))
    expect(await findFinishedFile(root, 'a/b/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('does not fall back to a file of the same name elsewhere in the folder', async () => {
    await put(path.join(root, 'Deep', 'song.flac'))
    expect(await findFinishedFile(root, '../x/song.flac')).toEqual({ found: false, reason: 'outside' })
    expect(await findFinishedFile(root, 'x\\..\\song.flac')).toEqual({ found: false, reason: 'outside' })
  })
})
