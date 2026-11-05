'use strict';

const PPTX2Json = require('pptx2json');
const JSZip     = require('jszip');
const vision    = require('../aicore-vision');

/**
 * Parse PowerPoint: extrai texto por slide e envia imagens para Vision.
 *
 * Estrutura interna de um .pptx (zip):
 *   ppt/slides/slide1.xml, slide2.xml, ...
 *   ppt/media/image1.png, image2.jpeg, ...
 *   ppt/slides/_rels/slide1.xml.rels  ← mapeia image rId → media path
 */
async function parsePptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  let totalTokens = 0;
  let hasOcr      = false;
  const sections  = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slideKey = slideFiles[i];
    const slideNum = i + 1;

    // 1. Extrair texto do XML do slide
    const xmlStr  = await zip.files[slideKey].async('string');
    const text    = extractTextFromSlideXml(xmlStr).trim();

    // 2. Carregar imagens do slide via relationships
    const relsKey   = slideKey.replace('slides/slide', 'slides/_rels/slide').replace('.xml', '.xml.rels');
    const mediaItems = zip.files[relsKey]
      ? await loadSlideImages(zip, zip.files[relsKey])
      : [];

    // 3. Processar imagens com Vision
    const imageDescriptions = [];
    for (const media of mediaItems) {
      try {
        const { text: desc, tokensUsed } = await vision.extractText(media.buffer, media.mimeType);
        imageDescriptions.push(desc);
        totalTokens += tokensUsed;
        hasOcr = true;
      } catch (e) {
        console.warn(`[pptx] Vision falhou em imagem do slide ${slideNum}:`, e.message);
      }
    }

    // 4. Montar seção do slide
    const parts = [];
    if (text)                         parts.push(text);
    if (imageDescriptions.length > 0) parts.push(imageDescriptions.map(d => `> ${d}`).join('\n'));

    sections.push(`## Slide ${slideNum}\n\n${parts.join('\n\n') || '_(sem conteúdo)_'}`);
  }

  return {
    parsedText: sections.join('\n\n---\n\n'),
    pageCount:  slideFiles.length,
    type:       'pptx',
    hasOcr,
    tokensUsed: totalTokens,
    parseSource: 'native',
  };
}

// ── Extrair texto de um slide XML ─────────────────────────────────────────────
function extractTextFromSlideXml(xml) {
  // Captura tudo dentro de <a:t>...</a:t> (DrawingML text runs)
  const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
  return matches
    .map(m => m.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join(' ');
}

// ── Carregar imagens referenciadas no slide via .rels ─────────────────────────
async function loadSlideImages(zip, relsFile) {
  const relsXml = await relsFile.async('string');
  // Extrair targets de imagens: Target="../media/imageN.xxx"
  const targets = [...relsXml.matchAll(/Target="\.\.\/media\/([^"]+)"/g)]
    .map(m => 'ppt/media/' + m[1]);

  const results = [];
  for (const mediaPath of targets) {
    if (!zip.files[mediaPath]) continue;
    const ext      = mediaPath.split('.').pop().toLowerCase();
    const mimeType = EXT_MIME[ext];
    if (!mimeType) continue; // ignorar formatos não visuais

    const buf = await zip.files[mediaPath].async('nodebuffer');
    results.push({ buffer: buf, mimeType });
  }
  return results;
}

const EXT_MIME = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  bmp:  'image/bmp',
  tiff: 'image/tiff',
  tif:  'image/tiff',
};

function slideNumber(path) {
  const m = path.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

module.exports = { parsePptx };
