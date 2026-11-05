'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Fallback parser via MarkItDown MCP (Microsoft).
 *
 * Requer: pip install markitdown-mcp
 *
 * Fluxo:
 *   1. Escreve buffer em arquivo temporário
 *   2. Inicia markitdown-mcp em modo stdio
 *   3. Envia initialize + tools/call convert_to_markdown(file://<tmp>)
 *   4. Lê resposta, extrai markdown, remove arquivo temp
 *
 * Tipos cobertos: EPUB, HTML, ZIP e qualquer outro que o MarkItDown suporte.
 */
async function parseWithMarkItDown(buffer, fileName) {
  // Escrever em /tmp com extensão preservada
  const ext     = path.extname(fileName) || '';
  const tmpPath = path.join(os.tmpdir(), `aidocparser-${uuidv4()}${ext}`);

  try {
    fs.writeFileSync(tmpPath, buffer);
    const markdown = await callMarkItDown(tmpPath);

    return {
      parsedText:  markdown,
      pageCount:   1,
      type:        'markitdown',
      hasOcr:      false,
      tokensUsed:  0,
      parseSource: 'markitdown',
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

// ── Protocolo MCP stdio com markitdown-mcp ────────────────────────────────────
function callMarkItDown(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('markitdown-mcp', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        reject(new Error('markitdown-mcp timeout (30s)'));
      }
    }, 30_000);

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      // Processar linhas completas (JSONRPC newline-delimited)
      const lines = stdout.split('\n');
      stdout = lines.pop(); // guarda linha incompleta

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Resposta ao initialize — agora enviar a tool call
          if (msg.id === 1 && msg.result?.serverInfo) {
            const toolCall = JSON.stringify({
              jsonrpc: '2.0', id: 2,
              method:  'tools/call',
              params:  {
                name:      'convert_to_markdown',
                arguments: { uri: 'file://' + filePath },
              },
            }) + '\n';
            proc.stdin.write(toolCall);
            return;
          }
          // Resposta à tool call
          if (msg.id === 2) {
            clearTimeout(timeout);
            resolved = true;
            proc.stdin.end();

            if (msg.error) {
              reject(new Error('markitdown-mcp: ' + msg.error.message));
              return;
            }
            // Extrair texto do content array
            const content = msg.result?.content || [];
            const text    = content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            resolve(text);
          }
        } catch { /* linha não-JSON, ignorar */ }
      }
    });

    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('error', err => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (err.code === 'ENOENT') {
          reject(new Error('markitdown-mcp não encontrado. Instale com: pip install markitdown-mcp'));
        } else {
          reject(err);
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error(`markitdown-mcp encerrou com código ${code}. stderr: ${stderr.slice(0, 200)}`));
      }
    });

    // Enviar initialize
    const init = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'initialize',
      params:  {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'aidocparser', version: '1.0.0' },
      },
    }) + '\n';

    proc.stdin.write(init);
  });
}

module.exports = { parseWithMarkItDown };
