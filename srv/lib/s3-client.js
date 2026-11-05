'use strict'

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3')

/**
 * Resolves Object Store credentials from VCAP_SERVICES (Cloud Foundry binding).
 * Falls back to environment variables for local development.
 */
function resolveCredentials() {
  const vcap = process.env.VCAP_SERVICES
  if (vcap) {
    const parsed = typeof vcap === 'string' ? JSON.parse(vcap) : vcap
    const binding = (parsed.objectstore || [])[0]?.credentials
    if (binding) {
      return {
        accessKeyId:     binding.access_key_id,
        secretAccessKey: binding.secret_access_key,
        bucket:          binding.bucket,
        endpoint:        binding.host,
        region:          binding.region || 'us-east-1',
      }
    }
  }

  // Local dev fallback via default-env.json (loaded by @sap/xsenv or manually)
  if (process.env.OBJECTSTORE_ACCESS_KEY_ID) {
    return {
      accessKeyId:     process.env.OBJECTSTORE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECTSTORE_SECRET_ACCESS_KEY,
      bucket:          process.env.OBJECTSTORE_BUCKET,
      endpoint:        process.env.OBJECTSTORE_ENDPOINT,
      region:          process.env.OBJECTSTORE_REGION || 'us-east-1',
    }
  }

  throw Object.assign(new Error('Object Store credentials not configured'), { name: 'MISSING_CREDS' })
}

class S3Service {
  constructor() {
    const creds = resolveCredentials()
    this.bucket = creds.bucket

    this.client = new S3Client({
      region: creds.region,
      credentials: {
        accessKeyId:     creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
      ...(creds.endpoint ? {
        endpoint: creds.endpoint.startsWith('http') ? creds.endpoint : `https://${creds.endpoint}`,
        forcePathStyle: true,
      } : {}),
    })
  }

  // ── List objects under a prefix ──────────────────────────────────────────────
  async listObjects(prefix = '') {
    const items = []
    let continuationToken

    do {
      const cmd = new ListObjectsV2Command({
        Bucket:            this.bucket,
        Prefix:            prefix,
        Delimiter:         '/',
        MaxKeys:           1000,
        ContinuationToken: continuationToken,
      })
      const resp = await this.client.send(cmd)

      // Folders (common prefixes)
      for (const cp of resp.CommonPrefixes || []) {
        const folderPrefix = cp.Prefix
        const name = folderPrefix.slice(prefix.length).replace(/\/$/, '')
        if (!name) continue
        items.push({
          name,
          objectKey:    folderPrefix,
          objectPath:   folderPrefix,
          itemType:     'folder',
          size:         0,
          lastModified: null,
          contentType:  'folder',
          isFolder:     true,
        })
      }

      // Files
      for (const obj of resp.Contents || []) {
        if (obj.Key === prefix) continue // skip the "folder marker" itself
        const name = obj.Key.slice(prefix.length)
        if (!name) continue
        items.push({
          name,
          objectKey:    obj.Key,
          objectPath:   obj.Key,
          itemType:     'file',
          size:         obj.Size,
          lastModified: obj.LastModified ? obj.LastModified.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
          contentType:  '',
          isFolder:     false,
        })
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
    } while (continuationToken)

    return items
  }

  // ── List all folders (recursive) for tree ────────────────────────────────────
  async listAllFolders(prefix = '', level = 0) {
    const folders = []
    const cmd = new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/' })
    const resp = await this.client.send(cmd)

    for (const cp of resp.CommonPrefixes || []) {
      const folderPrefix = cp.Prefix
      const name = folderPrefix.slice(prefix.length).replace(/\/$/, '')
      const parentPrefix = prefix
      folders.push({ name, folderPrefix, parentPrefix, level })
      const children = await this.listAllFolders(folderPrefix, level + 1)
      folders.push(...children)
    }
    return folders
  }

  // ── Put object ───────────────────────────────────────────────────────────────
  async putObject(key, body, contentType = 'application/octet-stream') {
    await this.client.send(new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      Body:        body,
      ContentType: contentType,
    }))
  }

  // ── Create folder marker ─────────────────────────────────────────────────────
  async createFolder(folderKey) {
    await this.client.send(new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         folderKey,
      Body:        '',
      ContentType: 'application/x-directory',
    }))
  }

  // ── Get object as stream ─────────────────────────────────────────────────────
  async getObjectStream(key) {
    const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return {
      stream:        resp.Body,
      contentType:   resp.ContentType,
      contentLength: resp.ContentLength,
      fileName:      key.split('/').pop(),
    }
  }

  // ── Copy single object ───────────────────────────────────────────────────────
  async copyObject(sourceKey, destKey) {
    await this.client.send(new CopyObjectCommand({
      Bucket:     this.bucket,
      CopySource: `${this.bucket}/${encodeURIComponent(sourceKey)}`,
      Key:        destKey,
    }))
  }

  // ── Copy all objects under a prefix (folder) ─────────────────────────────────
  async copyFolder(sourcePrefix, destPrefix) {
    const objects = await this._listAllObjects(sourcePrefix)
    for (const obj of objects) {
      const newKey = destPrefix + obj.Key.slice(sourcePrefix.length)
      await this.copyObject(obj.Key, newKey)
    }
  }

  // ── Delete single object ─────────────────────────────────────────────────────
  async deleteObject(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  // ── Delete all objects under a prefix (folder) ───────────────────────────────
  async deleteFolder(prefix, recursive = true) {
    const objects = await this._listAllObjects(prefix)

    if (!recursive && objects.length > 1) {
      throw Object.assign(new Error('Folder is not empty. Use recursive=true to delete all contents.'), { name: 'FOLDER_NOT_EMPTY' })
    }

    if (objects.length === 0) return 0

    // S3 batch delete — max 1000 per request
    let deleted = 0
    const chunks = []
    for (let i = 0; i < objects.length; i += 1000) chunks.push(objects.slice(i, i + 1000))

    for (const chunk of chunks) {
      await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: chunk.map(o => ({ Key: o.Key })), Quiet: true },
      }))
      deleted += chunk.length
    }
    return deleted
  }

  // ── Internal: list all keys under a prefix (no delimiter, full recursion) ────
  async _listAllObjects(prefix) {
    const all = []
    let continuationToken

    do {
      const cmd = new ListObjectsV2Command({
        Bucket:            this.bucket,
        Prefix:            prefix,
        MaxKeys:           1000,
        ContinuationToken: continuationToken,
      })
      const resp = await this.client.send(cmd)
      all.push(...(resp.Contents || []))
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
    } while (continuationToken)

    return all
  }
}

module.exports = S3Service
