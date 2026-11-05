# aidocparser — AI Document Parser

App standalone no SAP BTP para parse inteligente de documentos antes do upload no pipeline de grounding RAG do SAP AI Core. Funciona também como **central de administração de documentos**: navega, gerencia e exclui arquivos no Object Store (S3) e no SDM, com rastreabilidade via `docId` entre os dois repositórios.

---

## O problema

O pipeline do SAP AI Core Grounding (SDM) recebe arquivos como estão e faz chunking genérico. Resultados ruins com:

| Tipo | Problema |
|---|---|
| PDF com layout complexo | Tabelas viram texto caótico |
| PDF escaneado / imagem | Sem OCR, texto é zero ou lixo |
| Excel | Múltiplas abas, cells merged, fórmulas — pipeline não entende |
| Word | Formatação e hierarquia perdidas no chunking cego |

O `aidocparser` intercepta o arquivo **antes** de ir para o SDM, parseia com inteligência (incluindo OCR via AI Core GPT Vision), e sobe uma versão em markdown estruturado. Além do parse, expõe uma **API e um servidor MCP** para que outros apps do ecossistema (Zilo, agentes A2A) consumam o parse como serviço.

---

## Arquitetura de storage

```
Arquivo do usuário
       │
       ├── Original → SAP Object Store (S3-compatible)   SEMPRE
       │     • Presigned URL de 1h para download seguro
       │     • NUNCA entra no pipeline de vetorização
       │     • Key: originals/{userId}/{docId}/{nome-original}
       │
       └── Parseado (.md) → SDM  -ou-  S3 (escolha por upload)
             SDM → repositório de grounding (pipeline RAG automático)
             S3  → storage direto (sem vetorização)
             Key: parsed/{userId}/{docId}/{nome}_parsed.md
```

A separação garante que o repositório do AI Core Grounding (`8c102e74-d256-4456-b7eb-384e37a4a1ec`) receba **só o conteúdo otimizado**, enquanto o original permanece acessível via presigned URL — permite mostrar "Ver documento original" no Zilo e em outros apps.

---

## Fluxo do usuário

```
1. DROP       — arrasta ou seleciona arquivo (PDF/Excel/Word/PPTX/Imagem, máx 20MB)
2. PARSING    — backend extrai texto; páginas esparsas → OCR via GPT Vision
3. PREVIEW    — markdown gerado editável + badges (páginas, OCR, tokens usados)
               └── escolhe destino do parseado: SDM (grounding) ou S3
               └── escolhe pasta SDM via folder picker (se SDM)
               └── escolhe versão: processada (padrão) ou original
4. UPLOAD     — original → S3; parseado → SDM ou S3
5. DONE       — confirmação + link para baixar o original
```

---

## Stack (v2 — com CAP)

| Camada | Tecnologia | Referência |
|---|---|---|
| Frontend | UI5 TypeScript 1.148 — Work Zone nativo | `../s3-frontend/app/` |
| Backend | SAP CAP Node.js (`@protocol:'rest'`) | `../s3-frontend/srv/` |
| Auth | XSUAA próprio (`aidocparser-xsuaa-service`) | — |
| OCR | SAP AI Core — GPT Vision (deployment existente) | — |
| Storage original | SAP Object Store (S3-compat, AWS SDK v3) | `../s3-frontend/srv/lib/s3-client.js` |
| Storage parseado | SDM CMIS REST ou Object Store | — |
| Histórico | HANA / SQLite via CAP (entidade `ParsedDocument`) | `../Zilo/ziloback/` |
| MCP Server | `@modelcontextprotocol/sdk` stdio | novo |
| Deploy | MTA — managed approuter + nodejs + html5-repo | — |

> A migração Express → CAP é a principal mudança da v2. O CAP traz auth declarativa por role, entidades persistidas sem boilerplate e padroniza com o ecossistema (ziloback, s3-frontend).

---

## Estrutura do repositório (v2 — alvo)

```
aidocparser/
│
├── db/
│   └── schema.cds               # entidade ParsedDocument (histórico)
│
├── srv/
│   ├── file-manager-service.cds # S3 browse/rename/move/delete (do s3-frontend)
│   ├── file-manager-service.js  # handlers CAP + Express upload/download
│   ├── parser-service.cds       # parse, upload-com-parse, list docs, delete em cascata
│   ├── parser-service.js        # handlers: parse → S3+SDM → persist docId
│   ├── mcp-server.js            # MCP stdio — tools: parse_document, upload_document,
│   │                            #             list_documents, get_document, delete_document
│   ├── server.js                # cds.serve('all')
│   ├── package.json
│   └── lib/
│       ├── s3-client.js         # AWS SDK v3 (do s3-frontend — completo)
│       ├── sdm-client.js        # CMIS REST (listFolders, uploadFile, deleteFile)
│       ├── path-utils.js        # sanitização de paths (do s3-frontend)
│       ├── aicore-vision.js     # GPT Vision via AI Core HTTP direto
│       └── parsers/
│           ├── index.js         # dispatcher por MIME type
│           ├── pdf.js           # pdf-parse + pdfjs-dist + OCR seletivo
│           ├── excel.js         # exceljs → markdown por aba
│           ├── word.js          # mammoth + Vision para imagens embutidas
│           ├── image.js         # Vision direto
│           └── pptx.js          # pptx2json → markdown por slide (novo)
│
├── app/                         # UI5 TypeScript (baseado no s3-frontend)
│   └── webapp/
│       ├── controller/
│       │   ├── App.controller.ts
│       │   ├── Home.controller.ts   # navegação S3 (do s3-frontend)
│       │   └── Parse.controller.ts  # fluxo parse + upload (migrado do .js atual)
│       ├── view/
│       │   ├── App.view.xml
│       │   ├── Home.view.xml        # browser de arquivos S3
│       │   ├── Parse.view.xml       # 4 steps: drop→parse→preview→done
│       │   └── FolderPickerDialog.fragment.xml
│       ├── model/
│       │   ├── FileService.ts       # S3 API calls (do s3-frontend)
│       │   ├── ParseService.ts      # parse/upload API calls (novo)
│       │   └── types.ts
│       ├── manifest.json            # intents: DocParser-upload, DocParser-browse
│       └── i18n/
│           ├── i18n.properties      # PT-BR
│           └── i18n_en.properties
│
├── approuter/
│   ├── package.json
│   └── xs-app.json              # /api → srv, /* → html5-repo
│
├── mta.yaml                     # MTA completo (CAP)
├── xs-security.json             # roles: DocParserUser, DocParserAdmin, FileViewer, FileManager
├── package.json                 # scripts raiz
└── .gitignore
```

---

## Lógica de parse por tipo

### PDF (`parsers/pdf.js`)
1. `pdf-parse` extrai texto nativo
2. `pdfjs-dist` extrai por página individualmente
3. Página com < 100 chars → renderiza como PNG via `canvas`
4. PNG → AI Core GPT Vision → OCR
5. Saída: `## Página N\n{texto}` por página, separados por `---`

### Excel (`parsers/excel.js`)
1. `exceljs` lê todas as abas
2. Cada aba → `## Aba: {nome}`
3. Valores calculados (não fórmulas), rich text resolvido
4. Tabela markdown: `| col1 | col2 |`

### Word (`parsers/word.js`)
1. `mammoth.convertToMarkdown()` — preserva h1/h2/h3, listas, tabelas
2. Imagens embutidas → Vision → descrição textual inline

### Imagem (`parsers/image.js`)
1. Direto para AI Core GPT Vision
2. Extrai texto, preserva tabelas como markdown, descreve gráficos

### PowerPoint (`parsers/pptx.js`) — novo
1. `pptx2json` extrai slides como JSON
2. Texto por slide → `## Slide N: {título}`
3. Imagens nos slides → Vision → descrição inline

---

## API do backend

### Serviço de parse e documentos (`parser-service.cds`)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/api/parse/parseFile` | `multipart` campo `file` → `{ parsedText, pageCount, type, hasOcr, tokensUsed }` |
| `POST` | `/api/parse/uploadDocument` | `multipart` completo → `{ docId, originalStorage, parsedStorage }` + persiste no DB |
| `GET` | `/api/parse/listDocuments` | `?userId=` → lista de `ParsedDocument` do usuário |
| `DELETE` | `/api/parse/deleteDocument` | `?docId=` → deleta S3 original + SDM/S3 parsed em cascata + registro DB |
| `GET` | `/api/parse/presigned` | `?key=` → presigned URL (valida ownership) |
| `GET` | `/api/parse/sdmFolders` | `?parentId=` → lista pastas SDM |

### Serviço de navegação S3 (`file-manager-service.cds`) — do s3-frontend

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/files/listFiles` | `?prefix=` → lista objetos S3 |
| `GET` | `/api/files/getFolderTree` | árvore de pastas S3 |
| `POST` | `/api/files/createFolder` | cria pasta (objeto vazio `prefix/`) |
| `POST` | `/api/files/renameItem` | renomeia (copy + delete) |
| `POST` | `/api/files/moveItem` | move (copy + delete) |
| `POST` | `/api/files/deleteItem` | deleta arquivo ou pasta (recursivo) |
| `GET` | `/api/files/download` | stream de download |
| `POST` | `/api/files/upload` | upload multipart direto (sem parse) |

### POST /api/parse/uploadDocument — campos multipart

| Campo | Tipo | Descrição |
|---|---|---|
| `parsedText` | string | Markdown gerado |
| `originalName` | string | Nome original do arquivo |
| `mimeType` | string | MIME type original |
| `pageCount` | number | |
| `hasOcr` | boolean | |
| `tokensUsed` | number | |
| `parsedDestination` | `"sdm"` \| `"s3"` | Destino do parseado |
| `folderId` | string | Pasta SDM (obrigatório se parsedDestination=sdm) |
| `mode` | `"parsed"` \| `"raw"` | parsed = markdown, raw = original sem parse |
| `file` | binary | Arquivo original (vai sempre para S3) |

---

## MCP Server

O `srv/mcp-server.js` expõe o aidocparser como ferramenta para agentes LLM (Zilo, Claude, etc.) via protocolo MCP (stdio).

### Tools disponíveis

| Tool | Descrição |
|---|---|
| `parse_document` | Recebe base64 + mimeType, retorna markdown parseado |
| `upload_document` | Parse + upload completo, retorna docId + referências de storage |
| `list_documents` | Lista documentos do usuário com metadados |
| `get_document` | Retorna conteúdo + presigned URL de um docId |
| `delete_document` | Deleta original (S3) + parseado (SDM/S3) + registro DB |

### Como rodar o MCP server (local)

```bash
cd srv
node mcp-server.js   # modo stdio — conectar via MCP client

# registrar no Claude Code
claude mcp add aidocparser -- node /caminho/para/srv/mcp-server.js
```

---

## Schema do banco (CAP / HANA)

```cds
// db/schema.cds
namespace aidocparser;

entity ParsedDocument {
  key docId             : UUID;
      userId            : String(255);    // XSUAA subject
      originalName      : String(500);
      mimeType          : String(100);
      pageCount         : Integer;
      hasOcr            : Boolean default false;
      tokensUsed        : Integer default 0;
      originalS3Key     : String(1000);   // originals/{userId}/{docId}/...
      parsedDestination : String(3);      // "sdm" | "s3"
      parsedRef         : String(1000);   // S3 key ou SDM objectId
      parsedFolderId    : String(255);    // SDM folderId (se parsedDestination=sdm)
      createdAt         : Timestamp;
}
```

Esta entidade é o **elo de rastreabilidade** entre o original (S3) e o parseado (SDM/S3). O Zilo ou qualquer outro app pode guardar o `docId` e consultar de volta para obter presigned URL do original ou o conteúdo do parseado.

---

## Serviços BTP

Todos os serviços marcados como **managed** são provisionados automaticamente pelo `cf deploy` via `mta.yaml` — não é necessário criar manualmente no cockpit.

| Serviço | Nome da instância | Plano | Tipo |
|---|---|---|---|
| XSUAA | `aidocparser-xsuaa-service` | application | managed — MTA |
| HTML5 Repo Host | `aidocparser-html5-service` | app-host | managed — MTA |
| HTML5 Runtime | `aidocparser-html5-runtime` | app-runtime | managed — MTA |
| Destination | `aidocparser-destination-service` | lite | managed — MTA |
| Object Store | `aidocparser-object-store` | s3-standard | managed — MTA |
| SDM | `aidocparser-sdm-service` | standard | managed — MTA |
| HANA Cloud | `aidocparser-hana` | hdi-shared | managed — MTA |
| AI Core | `default_aicore` | — | existing (compartilhado da org) |

> **Object Store e SDM são instâncias próprias do aidocparser**, independentes das instâncias usadas pelo Zilo e pelo dms_ui_app. O repositório SDM de grounding (`8c102e74-...`) é referenciado por `onboardRepositoryId` na configuração do CMIS, mas a instância de serviço é separada.

> O AI Core permanece como `existing-service` porque o deployment de Vision (`d7a09bc4d6d523f7`) é compartilhado em toda a org — não faz sentido criar um novo.

---

## Desenvolvimento local

```bash
# Backend
cd srv
npm install
cds watch   # porta 4004, auth dummy, SQLite local

# Frontend
cd app
npm install
npm start   # porta 8080, proxia /api → localhost:4004

# MCP server (separado, opcional)
cd srv
node mcp-server.js
```

### default-env.json (srv/ — não commitar)

```json
{
  "VCAP_SERVICES": {
    "objectstore": [{
      "credentials": {
        "access_key_id": "...",
        "secret_access_key": "...",
        "bucket": "...",
        "host": "s3.amazonaws.com",
        "region": "us-east-1"
      }
    }],
    "aicore": [{
      "credentials": {
        "clientid": "...",
        "clientsecret": "...",
        "url": "...",
        "serviceurls": { "AI_API_URL": "..." }
      }
    }]
  }
}
```

---

## Build e deploy

```bash
# na raiz do repo
npm run build:mta
cf deploy mta_archives/aidocparser_1.0.0.mtar
```

### Checklist pós-deploy

1. BTP Cockpit → Security → Role Collections: atribuir `DocParser User` e `DocParser Admin`
2. Work Zone Channel Manager → Update content
3. Adicionar tiles no Work Zone (intents `DocParser-upload` e `DocParser-browse`)
4. Health check: `curl https://org-build-build-aidocparser-srv.cfapps.us10-001.hana.ondemand.com/health`
5. Smoke test: upload de PDF nativo, PDF escaneado, Excel, Word, Imagem, PPTX

---

## Independência e integração com outros apps

O aidocparser é **totalmente standalone** — não depende do Zilo nem de nenhum outro app para funcionar. Ele tem XSUAA, Object Store, SDM e HANA próprios.

A integração com outros apps (Zilo, futuros sistemas) é **opt-in via `docId`**: qualquer app que queira rastrear a origem de um documento pode guardar o `docId` retornado pelo upload e consultar de volta via API REST ou MCP.

### Como um app externo consome o aidocparser

```
1. App externo chama POST /api/parse/uploadDocument (ou MCP tool upload_document)
2. Recebe { docId, originalStorage, parsedStorage }
3. App externo persiste apenas o docId em sua própria entidade
4. Quando precisar:
   - "Ver original"     → GET /api/parse/presigned?key=originals/{userId}/{docId}/...
   - "Obter parseado"   → MCP tool get_document(docId)
   - "Deletar tudo"     → DELETE /api/parse/deleteDocument?docId=... (ou MCP)
```

### Integração específica com o Zilo (futura)

- Adicionar campo `docId` (String) na entidade de conversa ou documento do ziloback
- Link "Ver original" no chat: chama `GET /api/parse/presigned` do aidocparser
- Ferramenta MCP `get_document_context(docId)` disponível ao agente Zilo

### Grounding via AI Launchpad (roadmap — a verificar)

O grounding do AI Core hoje é configurado por repositório SDM no AI Launchpad. A questão em aberto é: **é possível referenciar um documento específico (por `docId` ou SDM objectId) como fonte no grounding, em vez de um repositório inteiro?** Isso permitiria que o Zilo indicasse ao AI Core exatamente quais documentos usar por conversa, em vez de buscar em todo o repositório. Investigar nas APIs do AI Core Orchestration e do Document Grounding.

---

## Sobre MarkItDown (Microsoft)

Avaliado como parser alternativo. **Decisão: usar como complemento pontual, não como base.**

| Critério | Decisão |
|---|---|
| É Python; stack é Node.js | Subprocess/microserviço — complexidade desnecessária para tipos já cobertos |
| PDF / Word / Excel | Cobertos pelos parsers Node.js **com** integração Vision do AI Core — superior ao MarkItDown |
| PowerPoint (PPTX) | Usar `pptx2json` npm para manter stack homogêneo |
| EPUB / HTML / ZIP | Formatos futuros — avaliar MarkItDown via subprocess quando necessário |
| Azure Doc Intelligence | Alternativa de OCR se AI Core Vision não estiver disponível |

---

## Plano de implementação (v2)

### Fase 1 — Migração do backend para CAP

**Objetivo:** substituir Express puro pelo CAP Node.js, aproveitando o `s3-frontend/srv/` como base.

| Passo | O que fazer | Fonte |
|---|---|---|
| 1.1 | Criar `srv/package.json` CAP: `@sap/cds ^8`, `@aws-sdk/client-s3 ^3`, `@aws-sdk/s3-request-presigner ^3`, `multer`, `passport` | `s3-frontend/srv/package.json` |
| 1.2 | Copiar `s3-client.js` (SDK v3, VCAP + default-env.json) para `srv/lib/` | `s3-frontend/srv/lib/s3-client.js` |
| 1.3 | Copiar `path-utils.js` para `srv/lib/` | `s3-frontend/srv/lib/path-utils.js` |
| 1.4 | Copiar `file-manager-service.cds` para `srv/` (ajustar `@path: '/api/files'`) | `s3-frontend/srv/file-manager-service.cds` |
| 1.5 | Copiar `file-manager-service.js` para `srv/` | `s3-frontend/srv/file-manager-service.js` |
| 1.6 | Mover `srv/parsers/` → `srv/lib/parsers/` sem alterar código | atual |
| 1.7 | Mover `srv/storage/sdm-client.js` → `srv/lib/sdm-client.js` | atual |
| 1.8 | Mover `srv/providers/aicore-vision.js` → `srv/lib/aicore-vision.js` | atual |
| 1.9 | Criar `srv/server.js` com `cds.serve('all')` | `s3-frontend/srv/server.js` |
| 1.10 | Instalar `canvas` em `srv/` para OCR de PDF escaneado | — |
| 1.11 | Testar `cds watch`: `GET /api/files/listFiles` com bucket real | — |

### Fase 2 — Schema e serviço de parse

**Objetivo:** entidade `ParsedDocument` e rotas de parse/upload como serviço CAP.

| Passo | O que fazer |
|---|---|
| 2.1 | Criar `db/schema.cds` com entidade `ParsedDocument` |
| 2.2 | Criar `srv/parser-service.cds` com actions `parseFile`, `uploadDocument`, `deleteDocument` e functions `listDocuments`, `getPresignedUrl`, `listSdmFolders` |
| 2.3 | Criar `srv/parser-service.js` portando lógica de `routes/parse.js` + `routes/upload.js` para handlers CAP |
| 2.4 | `uploadDocument` persiste registro em `ParsedDocument` via `INSERT INTO aidocparser.ParsedDocument` |
| 2.5 | `deleteDocument` deleta S3 original + SDM/S3 parsed + registro DB em sequência |
| 2.6 | Testar localmente: `POST /api/parse/parseFile` e `POST /api/parse/uploadDocument` |

### Fase 3 — Frontend UI5 TypeScript

**Objetivo:** migrar webapp de JS para TypeScript, baseando na estrutura do `s3-frontend/app/`.

| Passo | O que fazer | Fonte |
|---|---|---|
| 3.1 | Criar `app/` com estrutura TypeScript — copiar `s3-frontend/app/` como scaffolding | `s3-frontend/app/` |
| 3.2 | Manter `Home.controller.ts` (browse S3 com breadcrumb, search, type filter) | `s3-frontend/app/webapp/controller/Home.controller.ts` |
| 3.3 | Criar `Parse.controller.ts` portando `Main.controller.js` atual (4 steps) | atual `webapp/controller/Main.controller.js` |
| 3.4 | Criar `ParseService.ts` com chamadas às rotas de parse | — |
| 3.5 | Atualizar `manifest.json`: dois intents (`DocParser-upload`, `DocParser-browse`), duas rotas | — |
| 3.6 | Na tela Home: coluna "Parseado em", badge SDM/S3, botão "Ver original" (presigned), botão "Deletar tudo" (cascata) | — |
| 3.7 | Testar fluxo completo local: upload PDF → parse → preview → upload SDM → navegar Home | — |

### Fase 4 — MCP Server

**Objetivo:** expor parse + documentos como MCP tools para agentes LLM.

| Passo | O que fazer |
|---|---|
| 4.1 | Instalar `@modelcontextprotocol/sdk` em `srv/package.json` |
| 4.2 | Criar `srv/mcp-server.js` com `Server` stdio e 5 tools (parse, upload, list, get, delete) |
| 4.3 | Cada tool chama a lógica já existente em `parser-service.js` — sem duplicação |
| 4.4 | Adicionar script `"mcp": "node mcp-server.js"` no `package.json` raiz |
| 4.5 | Testar com `claude mcp add aidocparser -- node srv/mcp-server.js` localmente |

### Fase 5 — Novos formatos + MarkItDown fallback

**Objetivo:** ampliar cobertura de tipos com PPTX nativo e fallback automático via MarkItDown para tipos desconhecidos.

#### 5A — Parser PPTX

| Passo | O que fazer |
|---|---|
| 5A.1 | `npm install pptx2json` em `srv/` |
| 5A.2 | Criar `srv/lib/parsers/pptx.js` com extração slide a slide |
| 5A.3 | Imagens nos slides → base64 → Vision (mesmo padrão do `word.js`) |
| 5A.4 | Registrar MIME type `application/vnd.openxmlformats-officedocument.presentationml.presentation` no `index.js` |

#### 5B — MarkItDown fallback (tipos não cobertos)

MarkItDown (`pip install markitdown-mcp`) expõe um MCP server com um único tool: `convert_to_markdown(uri)` — aceita `file://`, `http://`, `https://` e `data:` URIs.

**Estratégia:** nossos parsers Node.js rodam primeiro (PDF/Word/Excel/Imagem/PPTX com Vision). Para tipos desconhecidos, o dispatcher faz fallback para o MarkItDown via subprocess ou MCP client.

| Passo | O que fazer |
|---|---|
| 5B.1 | Garantir `markitdown-mcp` instalado no ambiente BTP (`pip install markitdown-mcp` no buildpack Python, ou rodar como sidecar) |
| 5B.2 | Criar `srv/lib/parsers/markitdown-fallback.js` — escreve arquivo em `/tmp`, chama `markitdown-mcp` via `child_process.spawn` no modo stdio MCP, retorna markdown |
| 5B.3 | No `srv/lib/parsers/index.js`: se MIME não está no mapa, tentar fallback; se falhar também, lançar erro com mensagem clara |
| 5B.4 | Adicionar `EPUB`, `text/html`, `application/zip` como tipos com fallback explícito no dispatcher |
| 5B.5 | Logar qual parser foi usado (`source: 'native' \| 'markitdown'`) no resultado do parse — aparece no preview da UI e persiste no `ParsedDocument` |

**Tipos cobertos após Fase 5:**

| Tipo | Parser |
|---|---|
| PDF (nativo) | `pdf.js` — pdf-parse + pdfjs-dist |
| PDF (escaneado) | `pdf.js` — OCR via AI Core Vision |
| Excel (.xlsx/.xls) | `excel.js` — exceljs |
| Word (.docx/.doc) | `word.js` — mammoth + Vision |
| Imagem (PNG/JPG/WebP/TIFF) | `image.js` — AI Core Vision |
| PowerPoint (.pptx) | `pptx.js` — pptx2json + Vision |
| EPUB, HTML, ZIP, outros | `markitdown-fallback.js` — MarkItDown MCP |

**Uso no Claude Code (opcional, sem código):**
```bash
pip install markitdown-mcp
claude mcp add markitdown -- markitdown-mcp
# ferramenta: convert_to_markdown(uri)
```

### Fase 6 — Deploy BTP end-to-end

| Passo | O que fazer |
|---|---|
| 6.1 | `cf create-service objectstore s3-standard aidocparser-object-store` |
| 6.2 | Atualizar `mta.yaml` para estrutura CAP (módulo `aidocparser-db` para HANA deployer) |
| 6.3 | Atualizar `xs-security.json`: roles `DocParserUser`, `DocParserAdmin`, `FileViewer`, `FileManager` |
| 6.4 | `npm run build:mta && cf deploy` |
| 6.5 | Smoke test: todos os tipos de arquivo + navegação S3 + delete em cascata |
| 6.6 | Registrar no Work Zone (Channel Manager + tiles) |

### Fase 7 — Integração Zilo

| Passo | O que fazer |
|---|---|
| 7.1 | Adicionar entidade `ParsedDocumentRef` no schema do ziloback (`docId`, `appSource`, `userId`, `createdAt`) |
| 7.2 | Após upload via API REST ou MCP, Zilo persiste `docId` |
| 7.3 | Link "Ver original" no chat Zilo: chama `GET /api/parse/presigned?key=...` do aidocparser |
| 7.4 | Ferramenta `get_document_context(docId)` disponível ao agente Zilo via MCP |

---

## Decisões de design

| Decisão | Motivo |
|---|---|
| CAP Node.js no backend | Auth declarativa por role, entidades persistidas, padroniza com ziloback e s3-frontend |
| UI5 TypeScript | Padrão do s3-frontend; type safety nos models e controllers |
| Original SEMPRE no S3 | Separação clara entre "arquivo de referência" e "conteúdo para RAG" |
| Parseado flexível (SDM ou S3) | Serve clientes com SDM (grounding automático) e sem SDM |
| Delete em cascata | Consistência: apagar original apaga parseado; sem órfãos no storage |
| docId como elo de rastreabilidade | Qualquer app resolve original ↔ parseado com um único UUID sem acoplar ao aidocparser |
| App totalmente standalone | Não depende do Zilo; pode ser usado por qualquer projeto na org |
| Object Store e SDM via MTA | Provisionamento automático no `cf deploy`; sem pré-requisitos manuais no cockpit |
| SDM instância própria | Independente do SDM do Zilo/dms_ui_app; evita interferência entre apps |
| AI Core como existing-service | Deployment de Vision é compartilhado na org; não faz sentido criar instância separada |
| MCP server no mesmo srv/ | Reutiliza toda a lógica de parse sem duplicação; um único processo |
| MarkItDown não como base | Python em stack Node.js; parsers próprios + Vision são superiores para os tipos principais |
| XSUAA próprio | Standalone completo; deploy em qualquer subaccount sem dependência do zilo-xsuaa |
| OCR seletivo | Vision só chamado quando página < 100 chars — economiza tokens |
| Ownership check em presigned | `GET /api/parse/presigned` valida que o `key` pertence ao `userId` do JWT |

---

## Roadmap

| # | Item | Fase | Status |
|---|---|---|---|
| 1 | Migração backend Express → CAP | 1 | ✅ Concluído |
| 2 | Schema `ParsedDocument` + serviço de parse em CAP | 2 | ✅ Concluído |
| 3 | Frontend UI5 JS + navegação S3 + delete cascata | 3 | ✅ Concluído |
| 4 | MCP Server (5 tools) | 4 | ✅ Concluído |
| 5 | Parser PPTX (`pptx2json`) + MarkItDown fallback | 5 | ✅ Concluído |
| 6 | Deploy MTA end-to-end no BTP CF | 6 | ✅ Concluído |
| 7 | Instalar `canvas` para OCR em PDF escaneado | 1 | Pendente |
| 8 | Work Zone: Channel Manager update + adicionar tiles | 6 | Pendente |
| 9 | Smoke test todos os tipos de arquivo | 6 | Pendente |
| 10 | Integração Zilo: campo `docId` no ziloback + link "Ver original" no chat | 7 | Futura |
| 11 | Tela de histórico com filtros (usuário, tipo, data, destino) | 3 | Futura |
| 12 | API key pública (além de XSUAA) para consumo por sistemas externos | — | Futura |
| 13 | Suporte EPUB / HTML / ZIP via MarkItDown subprocess | — | Futura |
| 14 | Investigar grounding por documento específico no AI Launchpad | — | Futura (verificar viabilidade) |

---

## Estado atual do deploy (2026-11-05)

| Serviço | URL |
|---|---|
| Backend (srv) | `https://org-build-build-aidocparser-srv.cfapps.us10-001.hana.ondemand.com` |
| Health check | `https://org-build-build-aidocparser-srv.cfapps.us10-001.hana.ondemand.com/health` |
| Work Zone | `https://saamerbuild.launchpad.cfapps.us10.hana.ondemand.com/site/ai` |

**Serviços provisionados (todos via MTA):**
- `aidocparser-xsuaa-service` — XSUAA
- `aidocparser-html5-service` — HTML5 Repo Host
- `aidocparser-destination-service` — Destination
- `aidocparser-object-store` — Object Store S3
- `aidocparser-hana` — HANA HDI container
- `document-management-standard-service` — SDM (instância existente, reutilizada)
- `default_aicore` — AI Core (instância existente, compartilhada)

**Pendente pós-deploy:**
1. Work Zone → Channel Manager → Update HTML5 Apps → adicionar tiles com intents `DocParser-upload` e `DocParser-browse`
2. BTP Cockpit → Security → Role Collections → atribuir `DocParser User` / `DocParser Admin`
3. Smoke test com arquivos reais (PDF, Excel, Word, Imagem, PPTX)

**Gotchas encontrados no deploy:**
- `document-management-application/standard` não existe nesta subaccount — usar `sdm/build-runtime` como `existing-service`
- Approuter standalone não é necessário com `deploy_mode: html5-repo` — removido
- `xs-app.json` catchall deve usar `"service": "html5-apps-repo-rt"`, não `"destination"`
- `index.html` deve referenciar `resources/sap-ui-core.js` (relativo), não CDN com versão hardcoded
- `manifest.json` requer `sap.cloud: { public: true, service: "..." }` para o Work Zone reconhecer o app
