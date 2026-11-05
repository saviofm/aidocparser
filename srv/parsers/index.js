'use strict';
const { parsePdf } = require('./pdf');
const { parseExcel } = require('./excel');
const { parseWord } = require('./word');
const { parseImage } = require('./image');

const SUPPORTED_TYPES = {
  'application/pdf': parsePdf,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': parseExcel,
  'application/vnd.ms-excel': parseExcel,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': parseWord,
  'application/msword': parseWord,
  'image/png': parseImage,
  'image/jpeg': parseImage,
  'image/webp': parseImage,
  'image/tiff': parseImage,
  'image/gif': parseImage,
};

/**
 * Dispatches para o parser correto com base no MIME type.
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<{ parsedText, pageCount, type, hasOcr, tokensUsed, originalName, mimeType }>}
 */
async function dispatch(file) {
  const parser = SUPPORTED_TYPES[file.mimetype];
  if (!parser) {
    throw new Error(`Tipo de arquivo não suportado: ${file.mimetype}`);
  }

  const result = await parser(file.buffer, file.originalname);
  return {
    ...result,
    originalName: file.originalname,
    mimeType: file.mimetype,
  };
}

module.exports = { dispatch, SUPPORTED_TYPES };
