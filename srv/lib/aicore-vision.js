'use strict';
/**
 * OCR provider — GPT Vision via SAP AI Core (deployment de orquestração existente).
 * Usa HTTP direto para o deployment de orquestração (já configurado no AI Core).
 */
const axios = require('axios');

const DEPLOYMENT_ID = process.env.AICORE_DEPLOYMENT_ID || 'd7a09bc4d6d523f7';
const RESOURCE_GROUP = process.env.AICORE_RESOURCE_GROUP || 'default';

let _baseUrl = null;
let _token = null;
let _tokenExpiry = 0;

function getAiCoreCredentials() {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const binding = (vcap['aicore'] || [])[0]?.credentials;
  if (!binding) throw new Error('AI Core service binding não encontrado');
  _baseUrl = binding.serviceurls?.AI_API_URL || binding.url;
  return binding;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const creds = getAiCoreCredentials();
  const resp = await axios.post(
    `${creds.url}/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      auth: { username: creds.clientid, password: creds.clientsecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  _token = resp.data.access_token;
  _tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return _token;
}

/**
 * Extrai texto de uma imagem via GPT Vision.
 * @param {Buffer|string} imageInput  Buffer de imagem ou base64 string
 * @param {string} mimeType  Ex: "image/png"
 * @returns {{ text: string, tokensUsed: number }}
 */
async function extractText(imageInput, mimeType = 'image/png') {
  const token = await getToken();

  const base64 =
    typeof imageInput === 'string'
      ? imageInput
      : imageInput.toString('base64');

  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extraia TODO o texto visível nesta imagem. Se houver tabelas, preserve-as como markdown. Se houver gráficos, descreva os dados. Seja completo e não omita nada.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    max_tokens: 4096,
  };

  const resp = await axios.post(
    `${_baseUrl}/v2/inference/deployments/${DEPLOYMENT_ID}/chat/completions`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': RESOURCE_GROUP,
        'Content-Type': 'application/json',
      },
    }
  );

  const text = resp.data.choices?.[0]?.message?.content || '';
  const tokensUsed = resp.data.usage?.total_tokens || 0;
  return { text, tokensUsed };
}

module.exports = { extractText };
