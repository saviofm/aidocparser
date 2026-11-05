'use strict';
/**
 * Storage adapter — SAP Document Management (SDM) via CMIS REST.
 *
 * Autentica usando o service binding "sdm-instance" do VCAP_SERVICES.
 * O repositoryId é fixo (mesmo do dms_ui_app).
 */
const axios = require('axios');

const REPOSITORY_ID = '8c102e74-d256-4456-b7eb-384e37a4a1ec';

let _token = null;
let _tokenExpiry = 0;
let _baseUrl = null;
let _credentials = null;

function getCredentials() {
  if (_credentials) return _credentials;
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const binding = (vcap['document-management-repository'] || vcap['sdm'] || [])[0]?.credentials;
  if (!binding) throw new Error('SAP SDM service binding não encontrado em VCAP_SERVICES');
  _credentials = binding;
  _baseUrl = binding.uri;
  return binding;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const creds = getCredentials();
  const resp = await axios.post(
    `${creds.uaa.url}/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      auth: { username: creds.uaa.clientid, password: creds.uaa.clientsecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  _token = resp.data.access_token;
  _tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return _token;
}

function cmisUrl(path) {
  return `${_baseUrl}/browser/${REPOSITORY_ID}${path}`;
}

async function listFolders(parentId) {
  const token = await getToken();
  const objectId = parentId || 'root';
  const resp = await axios.get(cmisUrl(`/root`), {
    params: {
      cmisselector: 'children',
      objectId,
      filter: 'cmis:objectId,cmis:name,cmis:objectTypeId',
      maxItems: 200,
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const objects = resp.data?.objects || [];
  return objects
    .filter(o => o.object?.properties?.['cmis:objectTypeId']?.value === 'cmis:folder')
    .map(o => ({
      id: o.object.properties['cmis:objectId'].value,
      name: o.object.properties['cmis:name'].value,
    }));
}

async function uploadFile(buffer, fileName, contentType, folderId) {
  const token = await getToken();

  const FormData = require('form-data');
  const form = new FormData();
  form.append('cmisaction', 'createDocument');
  form.append('propertyId[0]', 'cmis:name');
  form.append('propertyValue[0]', fileName);
  form.append('propertyId[1]', 'cmis:objectTypeId');
  form.append('propertyValue[1]', 'cmis:document');
  form.append('objectId', folderId || 'root');
  form.append('content', buffer, { filename: fileName, contentType });

  const resp = await axios.post(cmisUrl('/root'), form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
  });

  return resp.data?.objectId || resp.data?.properties?.['cmis:objectId']?.value;
}

async function deleteFile(objectId) {
  const token = await getToken();
  const form = new (require('form-data'))();
  form.append('cmisaction', 'delete');
  form.append('objectId', objectId);

  await axios.post(cmisUrl('/root'), form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
  });
}

module.exports = { listFolders, uploadFile, deleteFile };
