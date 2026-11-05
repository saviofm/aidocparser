'use strict'

/**
 * aidocparser MCP Server
 *
 * Expõe parse e gestão de documentos como tools MCP para consumo por
 * agentes LLM (Zilo, Claude Code, etc.) via protocolo stdio.
 *
 * Uso:
 *   node mcp-server.js
 *   claude mcp add aidocparser -- node /caminho/para/srv/mcp-server.js
 *
 * As tools reutilizam a lógica de lib/ diretamente — sem duplicação de código
 * em relação ao parser-service.js.
 */

const { Server }              = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js')

const { v4: uuidv4 } = require('uuid')
const { dispatch }    = require('./lib/parsers/index')
const S3Service       = require('./lib/s3-client')
const sdm             = require('./lib/sdm-client')
const { getSignedUrl }       = require('@aws-sdk/s3-request-presigner')
const { GetObjectCommand }   = require('@aws-sdk/client-s3')

// ── DB via CDS (SQLite em dev, HANA em produção) ────────────────────────────
let _db = null
async function getDb() {
  if (_db) return _db
  try {
    _db = await cds.connect.to('db')
  } catch {
    _db = null
  }
  return _db
}

const ParsedDocument = () => cds.entities('aidocparser').ParsedDocument

// ── S3 singleton ────────────────────────────────────────────────────────────
let _s3 = null
function s3() {
  if (!_s3) _s3 = new S3Service()
  return _s3
}

async function makePresigned(key) {
  const client = s3()
  return getSignedUrl(client.client, new GetObjectCommand({ Bucket: client.bucket, Key: key }), { expiresIn: 3600 })
}

// ── Tool: parse_document ────────────────────────────────────────────────────
async function parseDocument({ base64, mimeType, fileName }) {
  if (!base64 || !mimeType) throw new Error('base64 e mimeType são obrigatórios')

  const buffer = Buffer.from(base64, 'base64')
  const file   = { buffer, mimetype: mimeType, originalname: fileName || 'document' }
  const result = await dispatch(file)

  return {
    parsedText:  result.parsedText,
    pageCount:   result.pageCount,
    type:        result.type,
    hasOcr:      result.hasOcr,
    tokensUsed:  result.tokensUsed,
    parseSource: result.parseSource || 'native',
  }
}

// ── Tool: upload_document ───────────────────────────────────────────────────
async function uploadDocument({ base64, mimeType, fileName, parsedDestination, folderId, mode, userId }) {
  if (!base64 || !mimeType || !fileName) throw new Error('base64, mimeType e fileName são obrigatórios')

  const buffer   = Buffer.from(base64, 'base64')
  const file     = { buffer, mimetype: mimeType, originalname: fileName }
  const effectiveUserId = userId || 'mcp-user'
  const docId    = uuidv4()
  const dest     = parsedDestination || 's3'
  const uploadMode = mode || 'parsed'

  // 1. Parse
  const parsed = await dispatch(file)

  // 2. Original → S3
  const s3Key = `originals/${effectiveUserId}/${docId}/${fileName}`
  await s3().putObject(s3Key, buffer, mimeType)
  const presignedUrl = await makePresigned(s3Key)

  // 3. Parseado → SDM ou S3
  const parsedFileName = fileName.replace(/\.[^.]+$/, '_parsed.md')
  const content = uploadMode === 'raw' ? buffer : Buffer.from(parsed.parsedText, 'utf-8')
  let parsedStorage, parsedRef

  if (dest === 'sdm') {
    if (!folderId) throw new Error('folderId é obrigatório para parsedDestination=sdm')
    const objectId = await sdm.uploadFile(content, parsedFileName, 'text/markdown', folderId)
    parsedRef     = objectId
    parsedStorage = { provider: 'sdm', objectId, folderId }
  } else {
    const pKey = `parsed/${effectiveUserId}/${docId}/${parsedFileName}`
    await s3().putObject(pKey, content, 'text/markdown; charset=utf-8')
    const pUrl = await makePresigned(pKey)
    parsedRef     = pKey
    parsedStorage = { provider: 's3', key: pKey, presignedUrl: pUrl }
  }

  // 4. Persistir no DB (best-effort — MCP não deve falhar se DB indisponível)
  try {
    const db = await getDb()
    if (db) {
      await db.run(INSERT.into(ParsedDocument()).entries({
        docId, userId: effectiveUserId, originalName: fileName, mimeType,
        pageCount: parsed.pageCount, hasOcr: parsed.hasOcr, tokensUsed: parsed.tokensUsed,
        originalS3Key: s3Key, parsedDestination: dest, parsedRef,
        parsedFolderId: folderId || null, createdAt: new Date().toISOString(),
      }))
    }
  } catch (e) {
    console.error('[mcp] DB persist failed (non-fatal):', e.message)
  }

  return {
    docId,
    originalName:    fileName,
    parsedFileName,
    pageCount:       parsed.pageCount,
    hasOcr:          parsed.hasOcr,
    tokensUsed:      parsed.tokensUsed,
    parseSource:     parsed.parseSource || 'native',
    originalStorage: { provider: 's3', key: s3Key, presignedUrl },
    parsedStorage,
  }
}

// ── Tool: list_documents ────────────────────────────────────────────────────
async function listDocuments({ userId, limit }) {
  const db = await getDb()
  if (!db) return { documents: [], warning: 'DB não disponível' }

  const rows = await db.run(
    SELECT.from(ParsedDocument()).where({ userId: userId || 'mcp-user' }).limit(limit || 50)
  )
  return { documents: rows }
}

// ── Tool: get_document ──────────────────────────────────────────────────────
async function getDocument({ docId }) {
  if (!docId) throw new Error('docId é obrigatório')

  const db  = await getDb()
  let doc   = null

  if (db) {
    doc = await db.run(SELECT.one.from(ParsedDocument()).where({ docId }))
  }

  if (!doc) throw new Error('Documento não encontrado: ' + docId)

  const presignedUrl = doc.originalS3Key ? await makePresigned(doc.originalS3Key) : null

  // Se parseado está no S3, retorna conteúdo direto
  let parsedContent = null
  if (doc.parsedDestination === 's3' && doc.parsedRef) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3')
      const resp = await s3().client.send(new GetObjectCommand({ Bucket: s3().bucket, Key: doc.parsedRef }))
      const chunks = []
      for await (const chunk of resp.Body) chunks.push(chunk)
      parsedContent = Buffer.concat(chunks).toString('utf-8')
    } catch (e) {
      parsedContent = null
    }
  }

  return {
    docId:             doc.docId,
    originalName:      doc.originalName,
    mimeType:          doc.mimeType,
    pageCount:         doc.pageCount,
    hasOcr:            !!doc.hasOcr,
    tokensUsed:        doc.tokensUsed,
    parsedDestination: doc.parsedDestination,
    parsedRef:         doc.parsedRef,
    presignedUrl,
    parsedContent,
    createdAt:         doc.createdAt,
  }
}

// ── Tool: delete_document ───────────────────────────────────────────────────
async function deleteDocument({ docId }) {
  if (!docId) throw new Error('docId é obrigatório')

  const db  = await getDb()
  let doc   = null

  if (db) {
    doc = await db.run(SELECT.one.from(ParsedDocument()).where({ docId }))
  }

  if (!doc) throw new Error('Documento não encontrado: ' + docId)

  const errors = []

  if (doc.originalS3Key) {
    await s3().deleteObject(doc.originalS3Key).catch(e => errors.push('S3 original: ' + e.message))
  }

  if (doc.parsedDestination === 's3' && doc.parsedRef) {
    await s3().deleteObject(doc.parsedRef).catch(e => errors.push('S3 parsed: ' + e.message))
  } else if (doc.parsedDestination === 'sdm' && doc.parsedRef) {
    await sdm.deleteFile(doc.parsedRef).catch(e => errors.push('SDM: ' + e.message))
  }

  if (db) {
    await db.run(DELETE.from(ParsedDocument()).where({ docId }))
  }

  return {
    success: errors.length === 0,
    docId,
    warnings: errors.length ? errors : undefined,
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'parse_document',
    description: 'Parseia um documento (PDF, Excel, Word, Imagem, PPTX) e retorna o texto em markdown. Usa OCR via AI Core Vision para páginas/imagens esparsas. Não persiste nada.',
    inputSchema: {
      type: 'object',
      properties: {
        base64:   { type: 'string', description: 'Conteúdo do arquivo em base64' },
        mimeType: { type: 'string', description: 'MIME type do arquivo (ex: application/pdf)' },
        fileName: { type: 'string', description: 'Nome original do arquivo (opcional, usado para detecção de tipo)' },
      },
      required: ['base64', 'mimeType'],
    },
  },
  {
    name: 'upload_document',
    description: 'Parseia o documento, salva o original no S3 e o parseado no SDM ou S3. Retorna docId para rastreabilidade.',
    inputSchema: {
      type: 'object',
      properties: {
        base64:            { type: 'string', description: 'Conteúdo do arquivo em base64' },
        mimeType:          { type: 'string', description: 'MIME type do arquivo' },
        fileName:          { type: 'string', description: 'Nome original do arquivo' },
        parsedDestination: { type: 'string', enum: ['sdm', 's3'], description: 'Destino do documento parseado (padrão: s3)' },
        folderId:          { type: 'string', description: 'ID da pasta SDM (obrigatório se parsedDestination=sdm)' },
        mode:              { type: 'string', enum: ['parsed', 'raw'], description: 'Versão a subir: parsed=markdown, raw=original (padrão: parsed)' },
        userId:            { type: 'string', description: 'ID do usuário para namespacing no S3 (opcional)' },
      },
      required: ['base64', 'mimeType', 'fileName'],
    },
  },
  {
    name: 'list_documents',
    description: 'Lista os documentos parseados de um usuário com metadados.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'ID do usuário (padrão: mcp-user)' },
        limit:  { type: 'number', description: 'Máximo de resultados (padrão: 50)' },
      },
    },
  },
  {
    name: 'get_document',
    description: 'Retorna metadados, presigned URL do original e conteúdo do parseado (quando no S3) para um docId.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'UUID do documento retornado pelo upload_document' },
      },
      required: ['docId'],
    },
  },
  {
    name: 'delete_document',
    description: 'Deleta o documento original (S3), o parseado (SDM ou S3) e o registro do banco em cascata.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'UUID do documento a deletar' },
      },
      required: ['docId'],
    },
  },
]

// ── Dispatch ────────────────────────────────────────────────────────────────
const HANDLERS = {
  parse_document:  parseDocument,
  upload_document: uploadDocument,
  list_documents:  listDocuments,
  get_document:    getDocument,
  delete_document: deleteDocument,
}

// ── Server setup ─────────────────────────────────────────────────────────────
async function main() {
  const server = new Server(
    { name: 'aidocparser', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const handler = HANDLERS[name]

    if (!handler) {
      return {
        content: [{ type: 'text', text: `Tool desconhecida: ${name}` }],
        isError: true,
      }
    }

    try {
      const result = await handler(args || {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Erro: ${err.message}` }],
        isError: true,
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // stderr não interfere com o protocolo MCP (que usa stdout)
  process.stderr.write('aidocparser MCP server iniciado\n')
}

main().catch(err => {
  process.stderr.write('Erro fatal: ' + err.message + '\n')
  process.exit(1)
})
