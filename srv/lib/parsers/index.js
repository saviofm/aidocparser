'use strict';

const { parsePdf }            = require('./pdf');
const { parseExcel }          = require('./excel');
const { parseWord }           = require('./word');
const { parseImage }          = require('./image');
const { parsePptx }           = require('./pptx');
const { parseWithMarkItDown } = require('./markitdown-fallback');

// Tipos com parser nativo (Node.js + AI Core Vision)
const NATIVE_TYPES = {
  'application/pdf':                                                                parsePdf,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':             parseExcel,
  'application/vnd.ms-excel':                                                       parseExcel,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':       parseWord,
  'application/msword':                                                             parseWord,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':     parsePptx,
  'image/png':   parseImage,
  'image/jpeg':  parseImage,
  'image/webp':  parseImage,
  'image/tiff':  parseImage,
  'image/gif':   parseImage,
};

// Tipos encaminhados diretamente para MarkItDown (sem tentar nativo)
const MARKITDOWN_TYPES = new Set([
  'application/epub+zip',
  'text/html',
  'application/zip',
  'application/x-zip-compressed',
  'application/rtf',
  'text/rtf',
]);

/**
 * Dispatches para o parser correto.
 *
 * Precedência:
 *   1. Parser nativo (Node.js + AI Core Vision)
 *   2. MarkItDown explícito (EPUB, HTML, ZIP, RTF)
 *   3. MarkItDown fallback genérico (tipo desconhecido)
 *
 * O campo `parseSource` no resultado indica qual caminho foi usado:
 *   'native' | 'markitdown'
 */
async function dispatch(file) {
  const { buffer, mimetype, originalname } = file;

  // 1. Parser nativo
  const nativeParser = NATIVE_TYPES[mimetype];
  if (nativeParser) {
    const result = await nativeParser(buffer, originalname);
    return {
      ...result,
      parseSource:  result.parseSource || 'native',
      originalName: originalname,
      mimeType:     mimetype,
    };
  }

  // 2. MarkItDown explícito ou fallback genérico
  const useMarkItDown = MARKITDOWN_TYPES.has(mimetype);
  const isUnknown     = !useMarkItDown;

  if (useMarkItDown || isUnknown) {
    try {
      const result = await parseWithMarkItDown(buffer, originalname);
      return {
        ...result,
        originalName: originalname,
        mimeType:     mimetype,
      };
    } catch (err) {
      if (isUnknown) {
        // Tipo realmente não suportado — propagar erro original mais claro
        throw new Error(`Tipo de arquivo não suportado: ${mimetype}. Instale markitdown-mcp (pip install markitdown-mcp) para suporte a formatos adicionais.`);
      }
      throw err;
    }
  }
}

module.exports = { dispatch, NATIVE_TYPES, MARKITDOWN_TYPES };
