'use strict';
const express = require('express');
const s3 = require('../storage/s3-client');
const sdm = require('../storage/sdm-client');

const router = express.Router();

// GET /api/documents/folders?provider=sdm   — lista pastas para o FolderPicker
router.get('/folders', async (req, res) => {
  const provider = req.query.provider || 'sdm';
  const parentId = req.query.parentId;
  try {
    if (provider === 'sdm') {
      const folders = await sdm.listFolders(parentId);
      res.json(folders);
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error('[folders]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/presigned?key=...   — gera nova presigned URL para original S3
router.get('/presigned', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key é obrigatório' });

  // garante que o usuário só acessa seus próprios arquivos
  const userId = req.user?.user_name || '';
  if (!key.startsWith(`originals/${userId}/`) && !key.startsWith(`parsed/${userId}/`)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  try {
    const presignedUrl = await s3.getPresignedUrl(key);
    res.json({ presignedUrl });
  } catch (err) {
    console.error('[presigned]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
