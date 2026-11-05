using { aidocparser } from '../db/schema';

@protocol: 'rest'
@path: '/api/parse'
@requires: 'authenticated-user'
service ParserService {

  // ── Histórico de documentos do usuário ────────────────────────────────────
  @readonly
  @requires: 'DocParserUser'
  entity Documents as projection on aidocparser.ParsedDocument
    excluding { userId };

  // ── Listar pastas SDM ─────────────────────────────────────────────────────
  @readonly
  @requires: 'DocParserUser'
  function sdmFolders(parentId : String) returns array of {
    id   : String;
    name : String;
  };

  // ── Presigned URL para download do original no S3 ────────────────────────
  @readonly
  @requires: 'DocParserUser'
  function presigned(key : String) returns {
    presignedUrl : String;
  };

  // ── Deletar documento em cascata (S3 original + SDM/S3 parsed + DB) ──────
  @requires: 'DocParserUser'
  action deleteDocument(docId : UUID) returns {
    success : Boolean;
    message : String;
  };

  // ── parse e upload são tratados via Express (multipart) em server.js ─────
  // POST /api/parse/parseFile      → svc._handleParseFile(req, res)
  // POST /api/parse/uploadDocument → svc._handleUploadDocument(req, res)
}
