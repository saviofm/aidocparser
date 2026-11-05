'use strict'

const cds = require('@sap/cds')
const multer = require('multer')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

cds.on('bootstrap', (app) => {
  // ── File manager upload/download (streaming, não passa por CDS action) ──
  app.post('/api/files/upload', upload.array('files'), async (req, res) => {
    const svc = await cds.connect.to('FileManagerService')
    return svc._handleUpload(req, res)
  })
  app.get('/api/files/download', async (req, res) => {
    const svc = await cds.connect.to('FileManagerService')
    return svc._handleDownload(req, res)
  })

  // ── Parse upload (multipart com arquivo original) ───────────────────────
  app.post('/api/parse/uploadDocument', upload.single('file'), async (req, res) => {
    const svc = await cds.connect.to('ParserService')
    return svc._handleUploadDocument(req, res)
  })

  // ── Parse (somente análise, sem persistir) ──────────────────────────────
  app.post('/api/parse/parseFile', upload.single('file'), async (req, res) => {
    const svc = await cds.connect.to('ParserService')
    return svc._handleParseFile(req, res)
  })

  // ── Health ──────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aidocparser-srv' }))
})

cds.once('listening', ({ server }) => {
  server.keepAliveTimeout = 3 * 60 * 1000
})

module.exports = cds.server
