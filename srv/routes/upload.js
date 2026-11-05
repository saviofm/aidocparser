'use strict';
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const s3 = require('../storage/s3-client');
const sdm = require('../storage/sdm-client');

const router = express.Router();
// original file may be re-sent for raw upload
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/*
  POST /api/upload
  Body (multipart):
    - parsedText     string  — markdown gerado pelo parse
    - originalName   string  — nome original do arquivo
    - mimeType       string  — mime type original
    - pageCount      number
    - hasOcr         boolean
    - tokensUsed     number
    - parsedDestination  "sdm" | "s3"   — onde subir o parseado
    - folderId       string  — pasta SDM (só quando parsedDestination=sdm)
    - mode           "parsed" | "raw"   — o que subir (raw = original sem parse)
    - file           binary  — obrigatório quando mode=raw

  Returns:
    {
      originalStorage:  { provider, key, presignedUrl }
      parsedStorage:    { provider, key, objectId? }   // objectId = SDM CMIS id
    }
*/
router.post('/', upload.single('file'), async (req, res) => {
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
  } = req.body;

  if (!originalName) return res.status(400).json({ error: 'originalName é obrigatório' });

  const userId = req.user?.user_name || 'unknown';
  const docId = uuidv4();

  try {
    // 1. Original sempre vai para o S3
    const originalBuffer = req.file?.buffer;
    let originalStorage = null;

    if (originalBuffer) {
      const s3Key = `originals/${userId}/${docId}/${originalName}`;
      await s3.putObject(s3Key, originalBuffer, mimeType);
      const presignedUrl = await s3.getPresignedUrl(s3Key);
      originalStorage = { provider: 's3', key: s3Key, presignedUrl };
    }

    // 2. Parseado vai para o destino escolhido
    let parsedStorage = null;
    const parsedFileName = originalName.replace(/\.[^.]+$/, '_parsed.md');
    const parsedBuffer = Buffer.from(
      mode === 'raw' ? (req.file?.buffer || Buffer.alloc(0)) : (parsedText || ''),
      'utf-8'
    );

    if (parsedDestination === 'sdm') {
      if (!folderId) return res.status(400).json({ error: 'folderId é obrigatório para destino SDM' });
      const objectId = await sdm.uploadFile(parsedBuffer, parsedFileName, 'text/markdown', folderId);
      parsedStorage = { provider: 'sdm', objectId, folderId };
    } else {
      const s3Key = `parsed/${userId}/${docId}/${parsedFileName}`;
      await s3.putObject(s3Key, parsedBuffer, 'text/markdown; charset=utf-8');
      const presignedUrl = await s3.getPresignedUrl(s3Key);
      parsedStorage = { provider: 's3', key: s3Key, presignedUrl };
    }

    res.json({
      docId,
      originalName,
      parsedFileName,
      pageCount: Number(pageCount) || 0,
      hasOcr: hasOcr === 'true' || hasOcr === true,
      tokensUsed: Number(tokensUsed) || 0,
      originalStorage,
      parsedStorage,
    });
  } catch (err) {
    console.error('[upload]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
