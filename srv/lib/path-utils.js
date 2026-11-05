'use strict'

// Characters that are not safe in S3 keys or folder names
const UNSAFE_CHARS = /[<>:"\\|?*\x00-\x1f]/g
// Prevent path traversal
const TRAVERSAL = /\.\.[/\\]/g

/**
 * Sanitizes a prefix/path received from the client.
 * Removes traversal sequences and ensures no leading slash.
 */
function sanitizePrefix(prefix) {
  if (!prefix || typeof prefix !== 'string') return ''
  return prefix
    .replace(TRAVERSAL, '')
    .replace(/^\/+/, '')      // no leading slash
    .replace(/\/{2,}/g, '/') // no double slashes
}

/**
 * Sanitizes a file or folder name.
 * Returns empty string if invalid.
 */
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return ''
  const clean = name.trim().replace(UNSAFE_CHARS, '').replace(TRAVERSAL, '')
  if (!clean || clean === '.' || clean === '..') return ''
  return clean
}

/**
 * Builds the new S3 key when renaming a file or folder.
 */
function buildNewKey(oldKey, newName, type) {
  const parts = oldKey.split('/')
  if (type === 'folder') {
    parts[parts.length - 2] = newName  // last segment before trailing '/'
    return parts.join('/')
  }
  parts[parts.length - 1] = newName
  return parts.join('/')
}

module.exports = { sanitizePrefix, sanitizeName, buildNewKey }
