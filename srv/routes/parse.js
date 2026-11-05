'use strict';
const express = require('express');
const multer = require('multer');
const { dispatch } = require('../parsers/index');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /api/parse
// Body: multipart/form-data  field: file
// Returns: { parsedText, pageCount, type, hasOcr, tokensUsed, originalName, mimeType }
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  try {
    const result = await dispatch(req.file);
    res.json(result);
  } catch (err) {
    console.error('[parse]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
