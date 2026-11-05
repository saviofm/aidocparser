'use strict';
/**
 * Storage adapter — SAP Object Store (S3-compatible via AWS SDK v2).
 *
 * Lê credenciais do VCAP_SERVICES binding "objectstore" automaticamente.
 * Localmente, pode usar variáveis de ambiente:
 *   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET
 */
const AWS = require('aws-sdk');

let _s3 = null;
let _bucket = null;

function getClient() {
  if (_s3) return { s3: _s3, bucket: _bucket };

  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const binding = (vcap.objectstore || [])[0]?.credentials;

  if (binding) {
    _s3 = new AWS.S3({
      accessKeyId: binding.access_key_id,
      secretAccessKey: binding.secret_access_key,
      endpoint: binding.uri,
      signatureVersion: 'v4',
      s3ForcePathStyle: true,
    });
    _bucket = binding.bucket;
  } else {
    // fallback local
    _s3 = new AWS.S3({
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      endpoint: process.env.S3_ENDPOINT,
      signatureVersion: 'v4',
      s3ForcePathStyle: true,
    });
    _bucket = process.env.S3_BUCKET;
  }

  return { s3: _s3, bucket: _bucket };
}

async function putObject(key, buffer, contentType) {
  const { s3, bucket } = getClient();
  await s3.putObject({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }).promise();
}

async function getPresignedUrl(key, expiresSeconds = 3600) {
  const { s3, bucket } = getClient();
  return s3.getSignedUrlPromise('getObject', {
    Bucket: bucket,
    Key: key,
    Expires: expiresSeconds,
  });
}

async function deleteObject(key) {
  const { s3, bucket } = getClient();
  await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
}

module.exports = { putObject, getPresignedUrl, deleteObject };
