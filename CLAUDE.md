# aidocparser — Configurações Internas (Claude Code)

Referência operacional para desenvolvimento e manutenção. Não publicar.

---

## Contexto do projeto

App standalone no SAP BTP para parse inteligente de documentos antes do upload no pipeline RAG do Zilo. Criado em 2026-11-05 como repo independente a partir do plano `ZILODOCPARSER_PLAN.md` do repo Zilo.

**Repo Zilo (referência):** `../Zilo`  
**App DMS de referência (padrão UI5/mta):** `../dms_ui_app`

---

## Ambiente BTP

- **CF org:** `org-build` / **space:** `build`
- **CF endpoint:** `api.cf.us10-001.hana.ondemand.com`
- **Repositório SDM grounding:** `8c102e74-d256-4456-b7eb-384e37a4a1ec` (mesmo do dms_ui_app)
- **AI Core Deployment ID (Vision/Orchestration):** `d7a09bc4d6d523f7`
- **AI Core Resource Group:** `default`

## URLs (após primeiro deploy)

| Serviço | URL |
|---|---|
| aidocparser app | `https://org-build-build-aidocparser-approuter.cfapps.us10-001.hana.ondemand.com` |
| aidocparser srv | `https://org-build-build-aidocparser-srv.cfapps.us10-001.hana.ondemand.com` |
| Health check | `https://org-build-build-aidocparser-srv.cfapps.us10-001.hana.ondemand.com/health` |
| Work Zone | `https://saamerbuild.launchpad.cfapps.us10.hana.ondemand.com/site/ai` |

---

## Arquitetura de storage (decisão fundamental)

```
Original  → SAP Object Store S3  SEMPRE
Parseado  → SDM (grounding RAG)  OU  S3  (escolha por upload)
```

- O repositório SDM de vetorização do AI Core NUNCA recebe o original
- S3 keys: `originals/{userId}/{docId}/{nome}` e `parsed/{userId}/{docId}/{nome}_parsed.md`
- Presigned URLs: 3600s (1h), geradas em `GET /api/documents/presigned?key=`
- Validação de ownership: o endpoint de presigned verifica que o key começa com `originals/{userId}/` ou `parsed/{userId}/`

---

## Serviços BTP

| Serviço | Nome da instância | Tipo |
|---|---|---|
| XSUAA | `aidocparser-xsuaa-service` | managed (novo) |
| HTML5 Repo Host | `aidocparser-html5-service` | managed (novo) |
| HTML5 Runtime | `aidocparser-html5-runtime` | managed (novo) |
| Destination | `aidocparser-destination-service` | managed (novo) |
| Object Store | `aidocparser-object-store` | managed (novo) — **pendente provisionamento** |
| AI Core | `default_aicore` | existing-service |
| SDM | `document-management-standard-service` | existing-service |

### Provisionamento do Object Store (pendente)
```bash
cf create-service objectstore standard aidocparser-object-store
# aguarda provisioning (pode demorar alguns minutos)
cf service aidocparser-object-store
```

O binding expõe credenciais em `VCAP_SERVICES.objectstore[0].credentials`:
- `access_key_id`, `secret_access_key`, `uri` (endpoint S3), `bucket`

---

## Stack

- **Frontend:** UI5 Freestyle 1.120 LTS (não React) — Work Zone nativo
  - `webapp/` contém o app UI5 com `ui5.yaml` (dev) e `ui5-deploy.yaml` (CF build)
  - Intent Work Zone: `DocParser-upload` (semantic object `DocParser`, action `upload`)
- **Backend:** Node.js + Express standalone, sem CAP, sem OData
  - `srv/` com multer para multipart, passport+xssec para auth JWT
- **Deploy:** MTA (`mta.yaml` na raiz), managed approuter

---

## Estrutura de arquivos chave

```
approuter/xs-app.json       # rotas: /api → srv, /* → html5-repo
srv/server.js               # entry: express + passport JWT
srv/routes/parse.js         # POST /api/parse
srv/routes/upload.js        # POST /api/upload
srv/routes/documents.js     # GET /api/documents/folders|presigned
srv/parsers/index.js        # dispatcher MIME type → parser
srv/parsers/pdf.js          # pdf-parse + pdfjs-dist + OCR Vision seletivo
srv/parsers/excel.js        # exceljs → markdown por aba
srv/parsers/word.js         # mammoth + Vision para imagens embutidas
srv/parsers/image.js        # Vision direto
srv/providers/aicore-vision.js  # HTTP direto ao AI Core deployment
srv/storage/s3-client.js    # AWS SDK v2 (putObject, getPresignedUrl, delete)
srv/storage/sdm-client.js   # CMIS REST (listFolders, uploadFile)
webapp/manifest.json        # intent DocParser-upload
webapp/view/Main.view.xml   # UI: 4 steps (drop/parsing/preview/done)
webapp/controller/Main.controller.js  # toda a lógica de fluxo
```

---

## Desenvolvimento local

```bash
# Backend
cd srv && npm install
# criar srv/.env com:
# PORT=3000
# S3_ENDPOINT=... S3_ACCESS_KEY=... S3_SECRET_KEY=... S3_BUCKET=...
# AICORE_DEPLOYMENT_ID=d7a09bc4d6d523f7
# AICORE_RESOURCE_GROUP=default
node server.js

# Frontend (proxia /api → localhost:3000)
cd webapp && npm install && npm start
```

Para testar storage S3 localmente, obter service key da instância:
```bash
cf create-service-key aidocparser-object-store local-key
cf service-key aidocparser-object-store local-key
```

---

## Build e deploy

```bash
# build MTA
npm run build:mta
# gera: mta_archives/aidocparser_0.0.1.mtar

# deploy
cf deploy mta_archives/aidocparser_0.0.1.mtar

# undeploy completo (cuidado — deleta serviços managed)
npm run undeploy
```

---

## Checklist pós-deploy

1. BTP Cockpit → Security → Role Collections: atribuir `DocParser User` e `DocParser Admin` aos usuários
2. Work Zone Channel Manager → Update content
3. Adicionar tile no site Work Zone com intent `DocParser-upload`
4. Verificar health: `curl https://org-build-build-aidocparser-srv.cfapps.us10-001.hana.ondemand.com/health`
5. Smoke test: upload de PDF nativo, PDF escaneado, Excel, Word, Imagem

---

## API endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/api/parse` | `multipart` campo `file` → `{ parsedText, pageCount, type, hasOcr, tokensUsed, originalName, mimeType }` |
| `POST` | `/api/upload` | ver campos abaixo → `{ docId, originalStorage, parsedStorage }` |
| `GET` | `/api/documents/folders` | `?provider=sdm[&parentId=]` → array de `{ id, name }` |
| `GET` | `/api/documents/presigned` | `?key=` → `{ presignedUrl }` (valida ownership) |

### POST /api/upload — campos multipart

```
parsedText          string
originalName        string
mimeType            string
pageCount           number
hasOcr              boolean
tokensUsed          number
parsedDestination   "sdm" | "s3"
folderId            string  (obrigatório se parsedDestination=sdm)
mode                "parsed" | "raw"
file                binary  (arquivo original, vai sempre para S3)
```

---

## Parsers — estado atual e pendências

### PDF (`parsers/pdf.js`)
- `pdf-parse` para texto nativo ✓
- `pdfjs-dist` para extração por página ✓
- OCR seletivo (< 100 chars/página) via Vision ✓ (lógica ok)
- **Pendente:** instalar `canvas` (node-canvas) para renderizar páginas como PNG
  ```bash
  cd srv && npm install canvas
  ```
  Sem canvas, o fallback ignora OCR silenciosamente (não quebra, apenas não faz OCR).

### Excel (`parsers/excel.js`) ✓
### Word (`parsers/word.js`) ✓ (Vision para imagens embutidas)
### Imagem (`parsers/image.js`) ✓

---

## aicore-vision.js — como funciona

Usa HTTP direto (não o SDK de orquestração) para o deployment `d7a09bc4d6d523f7`:

```
POST {AI_API_URL}/v2/inference/deployments/d7a09bc4d6d523f7/chat/completions
Headers:
  Authorization: Bearer {token}
  AI-Resource-Group: default
Body: { messages: [{ role: "user", content: [{ type: "text", ... }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } }] }] }
```

Token obtido via client_credentials do binding `aicore`. Cache interno com renovação 60s antes do expiry.

---

## sdm-client.js — CMIS REST

Autentica via `VCAP_SERVICES` binding `document-management-repository` (ou `sdm`).
URL base: `{credentials.uri}/browser/{REPOSITORY_ID}`.

- `listFolders(parentId)` — GET com `cmisselector=children`, filtra por `cmis:objectTypeId=cmis:folder`
- `uploadFile(buffer, fileName, contentType, folderId)` — POST multipart com `cmisaction=createDocument`

---

## Fixes conhecidos e gotchas

| Fix | Descrição |
|---|---|
| `ui5-task-zipper` em devDependencies | Sem isso o HTML5 repo recebe zip vazio |
| `build:cf` usa `--config ui5-deploy.yaml` | Não `ui5.yaml` |
| `canvas` é opcional | Sem ele, OCR em páginas PDF escaneadas é silenciosamente ignorado |
| VCAP binding SDM | Pode aparecer como `document-management-repository` ou `sdm` dependendo do plano |
| Object Store binding | `VCAP_SERVICES.objectstore[0].credentials` — atenção ao nome do serviço no VCAP |
| Presigned URL ownership | Sempre validar `key.startsWith('originals/{userId}/')` antes de gerar URL |
| multipart no upload | `multer` precisa estar antes do middleware de JSON; rotas que recebem `file` usam `upload.single('file')` |

---

## Roadmap

| # | Item |
|---|---|
| 1 | Testar parsers com arquivos reais (todos os tipos) |
| 2 | Instalar `canvas` para OCR de páginas PDF escaneadas |
| 3 | Provisionar `aidocparser-object-store` no BTP |
| 4 | Deploy MTA end-to-end + smoke test |
| 5 | Integração no Zilo: entidade `ParsedDocument` + "Ver original" via presigned URL |
| 6 | Tela de histórico de uploads por usuário |
| 7 | Suporte a múltiplos repositórios SDM (config por tenant) |
