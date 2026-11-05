'use strict'

const cds = require('@sap/cds')
const { sanitizePrefix, sanitizeName, buildNewKey } = require('./lib/path-utils')
const S3Service = require('./lib/s3-client')

module.exports = class FileManagerService extends cds.ApplicationService {

  async init() {
    this._s3 = null

    // ── CDS action handlers ───────────────────────────────────────────────────
    this.on('listFiles',    this._listFiles.bind(this))
    this.on('getFolderTree', this._getFolderTree.bind(this))
    this.on('createFolder', this._createFolder.bind(this))
    this.on('renameItem',   this._renameItem.bind(this))
    this.on('moveItem',     this._moveItem.bind(this))
    this.on('deleteItem',   this._deleteItem.bind(this))

    return super.init()
  }

  get s3() {
    if (!this._s3) this._s3 = new S3Service()
    return this._s3
  }

  // ── Scope check middleware ────────────────────────────────────────────────────
  _requireScopes(scopes) {
    return (req, res, next) => {
      const isDev = cds.env.requires?.auth?.kind === 'dummy' ||
                    process.env.NODE_ENV === 'development'
      if (isDev) return next()

      const user = cds.context?.user
      const hasScope = scopes.some(s => user?.is(s))
      if (!hasScope) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
      }
      next()
    }
  }

  // ── Upload handler (Express) ──────────────────────────────────────────────────
  async _handleUpload(req, res) {
    try {
      const prefix = sanitizePrefix(req.body.prefix || '')
      const files = req.files

      if (!files || files.length === 0) {
        return res.status(400).json({ error: { code: 'NO_FILES', message: 'No files provided' } })
      }

      const results = []
      for (const file of files) {
        const key = prefix ? `${prefix}${file.originalname}` : file.originalname
        await this.s3.putObject(key, file.buffer, file.mimetype)
        results.push({ fileName: file.originalname, key, success: true })
      }

      res.status(200).json({ results })
    } catch (err) {
      this._handleError(res, err)
    }
  }

  // ── Download handler (Express stream) ────────────────────────────────────────
  async _handleDownload(req, res) {
    try {
      const key = req.query.key
      if (!key) {
        return res.status(400).json({ error: { code: 'MISSING_KEY', message: 'key parameter required' } })
      }

      const safeKey = sanitizePrefix(key)
      const { stream, contentType, contentLength, fileName } = await this.s3.getObjectStream(safeKey)

      const inlineTypes = /^(image\/|video\/|audio\/|text\/|application\/pdf)/
      const disposition = inlineTypes.test(contentType || '') ? 'inline' : 'attachment'

      res.setHeader('Content-Type', contentType || 'application/octet-stream')
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(fileName)}"`)
      if (contentLength) res.setHeader('Content-Length', contentLength)

      stream.pipe(res)
    } catch (err) {
      this._handleError(res, err)
    }
  }

  // ── listFiles ────────────────────────────────────────────────────────────────
  async _listFiles(req) {
    try {
      const prefix = sanitizePrefix(req.data.prefix || '')
      return await this.s3.listObjects(prefix)
    } catch (err) {
      req.error(this._mapS3Error(err))
    }
  }

  // ── getFolderTree ─────────────────────────────────────────────────────────────
  async _getFolderTree(req) {
    try {
      return await this.s3.listAllFolders()
    } catch (err) {
      req.error(this._mapS3Error(err))
    }
  }

  // ── createFolder ──────────────────────────────────────────────────────────────
  async _createFolder(req) {
    try {
      const prefix = sanitizePrefix(req.data.prefix || '')
      const name   = sanitizeName(req.data.folderName)

      if (!name) return req.error(400, 'Invalid folder name')

      const folderKey = prefix ? `${prefix}${name}/` : `${name}/`
      await this.s3.createFolder(folderKey)

      return { success: true, message: `Folder "${name}" created`, folderPrefix: folderKey }
    } catch (err) {
      req.error(this._mapS3Error(err))
    }
  }

  // ── renameItem ────────────────────────────────────────────────────────────────
  async _renameItem(req) {
    try {
      const { sourceKey, newName, itemType } = req.data
      const safe = sanitizePrefix(sourceKey)
      const safeName = sanitizeName(newName)

      if (!safeName) return req.error(400, 'Invalid name')

      const newKey = buildNewKey(safe, safeName, itemType)

      if (itemType === 'folder') {
        await this.s3.copyFolder(safe, newKey)
        await this.s3.deleteFolder(safe)
      } else {
        await this.s3.copyObject(safe, newKey)
        await this.s3.deleteObject(safe)
      }

      return { success: true, message: 'Renamed successfully', newKey }
    } catch (err) {
      req.error(this._mapS3Error(err))
    }
  }

  // ── moveItem ──────────────────────────────────────────────────────────────────
  async _moveItem(req) {
    try {
      const { sourceKey, targetPrefix, itemType } = req.data
      const safe   = sanitizePrefix(sourceKey)
      const target = sanitizePrefix(targetPrefix)

      const fileName = safe.split('/').filter(Boolean).pop()
      const newKey   = target ? `${target}${fileName}${itemType === 'folder' ? '/' : ''}` : `${fileName}${itemType === 'folder' ? '/' : ''}`

      if (itemType === 'folder') {
        const sourceFolder = safe.endsWith('/') ? safe : `${safe}/`
        const targetFolder = newKey.endsWith('/') ? newKey : `${newKey}/`
        await this.s3.copyFolder(sourceFolder, targetFolder)
        await this.s3.deleteFolder(sourceFolder)
      } else {
        await this.s3.copyObject(safe, newKey)
        await this.s3.deleteObject(safe)
      }

      return { success: true, message: 'Moved successfully', newKey }
    } catch (err) {
      req.error(this._mapS3Error(err))
    }
  }

  // ── deleteItem ────────────────────────────────────────────────────────────────
  async _deleteItem(req) {
    try {
      const { objectKey, itemType, recursive } = req.data
      const safe = sanitizePrefix(objectKey)

      if (itemType === 'folder') {
        const folderPrefix = safe.endsWith('/') ? safe : `${safe}/`
        const count = await this.s3.deleteFolder(folderPrefix, recursive)
        return { success: true, message: `Deleted ${count} objects`, deletedCount: count }
      } else {
        await this.s3.deleteObject(safe)
        return { success: true, message: 'File deleted', deletedCount: 1 }
      }
    } catch (err) {
      if (err.name === 'FOLDER_NOT_EMPTY') {
        req.error(409, err.message, 'FOLDER_NOT_EMPTY')
      } else {
        req.error(this._mapS3Error(err))
      }
    }
  }

  // ── Error mapping ─────────────────────────────────────────────────────────────
  _mapS3Error(err) {
    const code = err.name || err.Code || 'UNKNOWN'
    if (code === 'NoSuchBucket')      return { code: 404, message: 'Bucket not found' }
    if (code === 'NoSuchKey')         return { code: 404, message: 'Object not found' }
    if (code === 'AccessDenied')      return { code: 403, message: 'Access denied to Object Store' }
    if (code === 'MISSING_CREDS')     return { code: 500, message: 'Object Store credentials not configured' }
    if (code === 'FOLDER_NOT_EMPTY')  return { code: 409, message: err.message, errorCode: 'FOLDER_NOT_EMPTY' }
    return { code: 500, message: err.message || 'Internal server error' }
  }

  _handleError(res, err) {
    const mapped = this._mapS3Error(err)
    res.status(mapped.code).json({ error: { code: err.name || 'ERROR', message: mapped.message } })
  }
}
