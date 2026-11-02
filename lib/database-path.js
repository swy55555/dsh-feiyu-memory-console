import fs from 'node:fs'
import path from 'node:path'

// Resolve existing junctions, including the parent of a not-yet-created database.
export function canonicalDatabasePath(file) {
  let current = path.resolve(file)
  const suffix = []
  for (;;) {
    try {
      const resolved = path.join(fs.realpathSync.native(current), ...suffix)
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error
      suffix.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
}

export function sameDatabasePath(a, b) {
  if (!a || !b) return false
  try { return canonicalDatabasePath(a) === canonicalDatabasePath(b) }
  catch { return false }
}
