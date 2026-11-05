'use strict';
const pdfParse = require('pdf-parse');
const vision = require('../aicore-vision');

const MIN_CHARS_PER_PAGE = 100;

/**
 * Parse PDF: texto nativo por página, fallback OCR via Vision para páginas esparsas.
 */
async function parsePdf(buffer) {
  const raw = await pdfParse(buffer);
  const totalPages = raw.numpages;

  // pdf-parse retorna texto concatenado; tentamos dividir por página via marker
  // Para OCR seletivo precisamos processar página a página com pdfjs
  let pages;
  try {
    pages = await extractPageTexts(buffer, totalPages);
  } catch {
    // fallback: trata como uma única "página"
    pages = [raw.text];
  }

  let totalTokens = 0;
  let ocrCount = 0;
  const sections = [];

  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i] || '';

    if (pageText.trim().length < MIN_CHARS_PER_PAGE) {
      // página esparsa → OCR via Vision
      try {
        const pageImage = await renderPageAsImage(buffer, i);
        const { text, tokensUsed } = await vision.extractText(pageImage, 'image/png');
        sections.push(`## Página ${i + 1}\n\n${text}`);
        totalTokens += tokensUsed;
        ocrCount++;
      } catch (err) {
        console.warn(`[pdf] OCR falhou na página ${i + 1}:`, err.message);
        sections.push(`## Página ${i + 1}\n\n${pageText}`);
      }
    } else {
      sections.push(`## Página ${i + 1}\n\n${pageText.trim()}`);
    }
  }

  return {
    parsedText: sections.join('\n\n---\n\n'),
    pageCount: totalPages,
    type: 'pdf',
    hasOcr: ocrCount > 0,
    tokensUsed: totalTokens,
  };
}

async function extractPageTexts(buffer, numPages) {
  // pdfjs-dist para extração por página
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const texts = [];

  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(' ');
    texts.push(text);
  }

  return texts;
}

async function renderPageAsImage(buffer, pageIndex) {
  // pdfjs render → canvas → png buffer
  // Requer canvas (node-canvas) ou sharp para conversão
  // Simplificado: retorna buffer vazio se canvas não disponível — OCR retornará texto vazio
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');

    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toBuffer('image/png');
  } catch (err) {
    console.warn('[pdf] canvas render indisponível:', err.message);
    return Buffer.alloc(0);
  }
}

module.exports = { parsePdf };
