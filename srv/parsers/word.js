'use strict';
const mammoth = require('mammoth');
const vision = require('../providers/aicore-vision');

/**
 * Parse Word: mammoth → markdown estruturado.
 * Imagens embutidas → Vision → descrição textual.
 */
async function parseWord(buffer) {
  let totalTokens = 0;

  // Converte com tratamento de imagens customizado
  const result = await mammoth.convertToMarkdown(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async image => {
        try {
          const imgBuffer = await image.read();
          const { text, tokensUsed } = await vision.extractText(imgBuffer, image.contentType || 'image/png');
          totalTokens += tokensUsed;
          return { src: `[Imagem: ${text.substring(0, 200)}...]` };
        } catch {
          return { src: '[Imagem não processada]' };
        }
      }),
    }
  );

  return {
    parsedText: result.value,
    pageCount: 1, // Word não expõe contagem de páginas facilmente
    type: 'word',
    hasOcr: totalTokens > 0,
    tokensUsed: totalTokens,
  };
}

module.exports = { parseWord };
