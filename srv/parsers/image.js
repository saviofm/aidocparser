'use strict';
const vision = require('../providers/aicore-vision');

/**
 * Parse Imagem: direto para AI Core GPT Vision.
 */
async function parseImage(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tiff: 'image/tiff', gif: 'image/gif' };
  const mimeType = mimeMap[ext] || 'image/png';

  const { text, tokensUsed } = await vision.extractText(buffer, mimeType);

  return {
    parsedText: text,
    pageCount: 1,
    type: 'image',
    hasOcr: true,
    tokensUsed,
  };
}

module.exports = { parseImage };
