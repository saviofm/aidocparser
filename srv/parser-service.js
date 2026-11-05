'use strict'

const cds = require('@sap/cds')
const { v4: uuidv4 } = require('uuid')
const { dispatch } = require('./lib/parsers/index')
const S3Service = require('./lib/s3-client')
const sdm = require('./lib/sdm-client')

const ParsedDocument = () => cds.entities('aidocparser').ParsedDocument

module.exports = class ParserService extends cds.ApplicationService {

  async init() {
    this._s3 = null

    this.on('sdmFolders',    this._sdmFolders.bind(this))
    this.on('presigned',     this._presigned.bind(this))
    this.on('deleteDocument', this._deleteDocument.bind(this))

    return super.init()
  }

  get s3() {
    if (!this._s3) this._s3 = new S3Service()
    return this._s3
  }

  _userId(req) {
    // CDS context em produção; fallback para dev dummy
    return cds.context?.user?.id || req?.user?.id || req?.user?.user_name || 'local-dev'
  }

  // ── Express handler: POST /api/parse/parseFile ────────────────────────────
  async _handleParseFile(req, res) {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' })
    try {
      const result = await dispatch(req.file)
      res.json(result)
    } catch (err) {
      console.error('[parseFile]', err)
      res.status(500).json({ error: err.message })
    }
  }

  // ── Express handler: POST /api/parse/uploadDocument ───────────────────────
  async _handleUploadDocument(req, res) {
    const {
      parsedText,
      originalName,
      mimeType,
      pageCount,
      hasOcr,
      tokensUsed,
      parsedDestination = 'sdm',
      folderId,
      mode = 'parsed',
    } = req.body

    if (!originalName) return res.status(400).json({ error: 'originalName é obrigatório' })

    const userId = this._userId(req)
    const docId  = uuidv4()

    try {
      // 1. Original → S3 sempre
      let originalStorage = null
      if (req.file?.buffer) {
        const s3Key = `originals/${userId}/${docId}/${originalName}`
        await this.s3.putObject(s3Key, req.file.buffer, mimeType)
        const presignedUrl = await this._makePresigned(s3Key)
        originalStorage = { provider: 's3', key: s3Key, presignedUrl }
      }

      // 2. Parseado → SDM ou S3
      const parsedFileName = originalName.replace(/\.[^.]+$/, '_parsed.md')
      const content = mode === 'raw' ? (req.file?.buffer || Buffer.alloc(0)) : Buffer.from(parsedText || '', 'utf-8')
      let parsedStorage = null
      let parsedRef = null

      if (parsedDestination === 'sdm') {
        if (!folderId) return res.status(400).json({ error: 'folderId é obrigatório para destino SDM' })
        const objectId = await sdm.uploadFile(content, parsedFileName, 'text/markdown', folderId)
        parsedRef = objectId
        parsedStorage = { provider: 'sdm', objectId, folderId }
      } else {
        const s3Key = `parsed/${userId}/${docId}/${parsedFileName}`
        await this.s3.putObject(s3Key, content, 'text/markdown; charset=utf-8')
        const presignedUrl = await this._makePresigned(s3Key)
        parsedRef = s3Key
        parsedStorage = { provider: 's3', key: s3Key, presignedUrl }
      }

      // 3. Persistir registro no DB
      await INSERT.into(ParsedDocument()).entries({
        docId,
        userId,
        originalName,
        mimeType:          mimeType || '',
        pageCount:         Number(pageCount) || 0,
        hasOcr:            hasOcr === 'true' || hasOcr === true,
        tokensUsed:        Number(tokensUsed) || 0,
        originalS3Key:     originalStorage?.key || '',
        parsedDestination: parsedDestination === 'sdm' ? 'sdm' : 's3',
        parsedRef,
        parsedFolderId:    folderId || null,
        createdAt:         new Date().toISOString(),
      })

      res.json({
        docId,
        originalName,
        parsedFileName,
        pageCount:    Number(pageCount) || 0,
        hasOcr:       hasOcr === 'true' || hasOcr === true,
        tokensUsed:   Number(tokensUsed) || 0,
        originalStorage,
        parsedStorage,
      })
    } catch (err) {
      console.error('[uploadDocument]', err)
      res.status(500).json({ error: err.message })
    }
  }

  // ── CDS function: sdmFolders ──────────────────────────────────────────────
  async _sdmFolders(req) {
    try {
      return await sdm.listFolders(req.data.parentId)
    } catch (err) {
      req.error(500, err.message)
    }
  }

  // ── CDS function: presigned ───────────────────────────────────────────────
  async _presigned(req) {
    const { key } = req.data
    const userId = this._userId(req)

    if (!key) return req.error(400, 'key é obrigatório')

    // Validação de ownership: só originals/ ou parsed/ do próprio userId
    const ownedPrefixes = [`originals/${userId}/`, `parsed/${userId}/`]
    if (!ownedPrefixes.some(p => key.startsWith(p))) {
      return req.error(403, 'Acesso negado a este objeto')
    }

    const presignedUrl = await this._makePresigned(key)
    return { presignedUrl }
  }

  // ── CDS action: deleteDocument ────────────────────────────────────────────
  async _deleteDocument(req) {
    const { docId } = req.data
    const userId = this._userId(req)

    const doc = await SELECT.one.from(ParsedDocument()).where({ docId })
    if (!doc) return req.error(404, 'Documento não encontrado')

    // Admin pode deletar qualquer doc; usuário só o próprio
    const isAdmin = cds.context?.user?.is('DocParserAdmin')
    if (!isAdmin && doc.userId !== userId) return req.error(403, 'Acesso negado')

    try {
      // 1. Deletar original no S3
      if (doc.originalS3Key) {
        await this.s3.deleteObject(doc.originalS3Key).catch(e => console.warn('[delete] S3 original:', e.message))
      }

      // 2. Deletar parseado no S3 ou SDM
      if (doc.parsedDestination === 's3' && doc.parsedRef) {
        await this.s3.deleteObject(doc.parsedRef).catch(e => console.warn('[delete] S3 parsed:', e.message))
      } else if (doc.parsedDestination === 'sdm' && doc.parsedRef) {
        await sdm.deleteFile(doc.parsedRef).catch(e => console.warn('[delete] SDM:', e.message))
      }

      // 3. Deletar registro DB
      await DELETE.from(ParsedDocument()).where({ docId })

      return { success: true, message: 'Documento deletado com sucesso' }
    } catch (err) {
      console.error('[deleteDocument]', err)
      return req.error(500, err.message)
    }
  }

  // ── Util: gerar presigned URL via SDK v3 ──────────────────────────────────
  async _makePresigned(key) {
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
    const { GetObjectCommand } = require('@aws-sdk/client-s3')
    return getSignedUrl(this.s3.client, new GetObjectCommand({ Bucket: this.s3.bucket, Key: key }), { expiresIn: 3600 })
  }
}
