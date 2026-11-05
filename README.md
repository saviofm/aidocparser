# aidocparser — AI Document Parser

App standalone no SAP BTP para parse inteligente de documentos antes do upload no pipeline de grounding RAG do SAP AI Core.

---

## O problema

O pipeline do SAP AI Core Grounding (SDM) recebe arquivos como estão e faz chunking genérico. Resultados ruins com:

| Tipo | Problema |
|---|---|
| PDF com layout complexo | Tabelas viram texto caótico |
| PDF escaneado / imagem | Sem OCR, texto é zero ou lixo |
| Excel | Múltiplas abas, cells merged, fórmulas — pipeline não entende |
| Word | Formatação e hierarquia perdidas no chunking cego |

O `aidocparser` intercepta o arquivo **antes** de ir para o SDM, parseia com inteligência (incluindo OCR via AI Core GPT Vision), e sobe uma versão em markdown estruturado.

---

## Arquitetura de storage

```
Arquivo do usuário
       │
       ├── Original → SAP Object Store (S3-compatible)
       │     • Sempre, independente do modo de upload
       │     • Presigned URL de 1h para download seguro
       │     • NUNCA entra no pipeline de vetorização do AI Core
       │     • Key: originals/{userId}/{docId}/{nome-original}
       │
       └── Parseado (.md) → SDM -ou- S3 (escolha por upload)
             SDM → repositório de grounding (pipeline RAG)
             S3  → storage direto (sem vetorização automática)
             Key: parsed/{userId}/{docId}/{nome}_parsed.md
```

A separação garante que o repositório do AI Core Grounding (`8c102e74-d256-4456-b7eb-384e37a4a1ec`) receba **só o conteúdo otimizado**, enquanto o original permanece acessível via presigned URL — permite mostrar "Ver documento original" no Zilo no futuro.

---

## Fluxo do usuário

```
1. DROP       — arrasta ou seleciona arquivo (PDF/Excel/Word/Imagem, máx 20MB)
2. PARSING    — backend extrai texto; páginas esparsas → OCR via GPT Vision
3. PREVIEW    — markdown gerado editável + badges (páginas, OCR, tokens usados)
               └── escolhe destino do parseado: SDM (grounding) ou S3
               └── escolhe pasta SDM via folder picker (se SDM)
               └── escolhe versão: processada (padrão) ou original
4. UPLOAD     — original → S3; parseado → SDM ou S3
5. DONE       — confirmação + link para baixar o original
```

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | UI5 Freestyle 1.120 LTS — Work Zone nativo |
| Backend | Node.js + Express (standalone, sem CAP) |
| Auth | XSUAA próprio (`aidocparser-xsuaa-service`) |
| OCR | SAP AI Core — GPT Vision (deployment existente) |
| Storage original | SAP Object Store (S3-compatible, AWS SDK v2) |
| Storage parseado | SDM CMIS REST ou Object Store |
| Deploy | MTA — managed approuter + nodejs + html5-repo |

---

## Estrutura do repositório

```
aidocparser/
├── approuter/
│   ├── package.json          # @sap/approuter
│   └── xs-app.json           # rotas: /api → srv, /* → html5-repo
│
├── srv/                      # Express backend
│   ├── server.js             # app entry, auth passport+xssec
│   ├── package.json
│   ├── routes/
│   │   ├── parse.js          # POST /api/parse (multer → dispatch)
│   │   ├── upload.js         # POST /api/upload (original→S3, parsed→SDM|S3)
│   │   └── documents.js      # GET /api/documents/folders, /api/documents/presigned
│   ├── parsers/
│   │   ├── index.js          # dispatcher por MIME type
│   │   ├── pdf.js            # pdf-parse + OCR seletivo por página (pdfjs-dist)
│   │   ├── excel.js          # exceljs → markdown por aba
│   │   ├── word.js           # mammoth → markdown + Vision em imagens embutidas
│   │   └── image.js          # Vision direto
│   ├── providers/
│   │   └── aicore-vision.js  # GPT Vision via AI Core HTTP direto
│   └── storage/
│       ├── s3-client.js      # SAP Object Store (putObject, getPresignedUrl, delete)
│       └── sdm-client.js     # CMIS REST (listFolders, uploadFile)
│
├── webapp/                   # UI5 app
│   ├── Component.js          # UIComponent, app state model
│   ├── manifest.json         # intent DocParser-upload (Work Zone)
│   ├── index.html
│   ├── xs-app.json           # xs-app para o zip do html5-repo
│   ├── ui5.yaml              # dev server + proxy /api → localhost:3000
│   ├── ui5-deploy.yaml       # build CF (ui5-task-zipper)
│   ├── package.json
│   ├── view/
│   │   ├── App.view.xml
│   │   ├── Main.view.xml     # 4 steps: drop, parsing, preview, done
│   │   └── FolderPickerDialog.fragment.xml
│   ├── controller/
│   │   ├── App.controller.js
│   │   └── Main.controller.js  # toda a lógica de fluxo
│   └── i18n/
│       └── i18n.properties
│
├── mta.yaml                  # MTA completo (approuter + srv + webapp + resources)
├── xs-security.json          # scopes: DocParserUser, DocParserAdmin
├── package.json              # scripts: build:mta, start:srv, start:ui
└── .gitignore
```

---

## Lógica de parse por tipo

### PDF (`parsers/pdf.js`)
1. `pdf-parse` extrai texto nativo
2. `pdfjs-dist` extrai por página individualmente
3. Página com < 100 chars → renderiza como imagem PNG (via `canvas`)
4. Imagem → AI Core GPT Vision → OCR
5. Resultado: `## Página N\n\n{texto}` por página, separados por `---`

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

---

## API do backend

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/api/parse` | `multipart/form-data` campo `file` → `{ parsedText, pageCount, type, hasOcr, tokensUsed, originalName, mimeType }` |
| `POST` | `/api/upload` | `multipart` com todos os campos → `{ docId, originalStorage, parsedStorage }` |
| `GET` | `/api/documents/folders` | `?provider=sdm[&parentId=]` → lista pastas SDM |
| `GET` | `/api/documents/presigned` | `?key=` → nova presigned URL S3 (validação de ownership por userId) |

### POST /api/upload — campos

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
| `mode` | `"parsed"` \| `"raw"` | Versão a subir (parsed = markdown, raw = original) |
| `file` | binary | Arquivo original (necessário para salvar no S3) |

---

## Serviços BTP

| Serviço | Nome da instância | Plano | Tipo |
|---|---|---|---|
| XSUAA | `aidocparser-xsuaa-service` | application | **novo** (managed) |
| HTML5 Repo Host | `aidocparser-html5-service` | app-host | **novo** (managed) |
| HTML5 Runtime | `aidocparser-html5-runtime` | app-runtime | **novo** (managed) |
| Destination | `aidocparser-destination-service` | lite | **novo** (managed) |
| Object Store | `aidocparser-object-store` | standard | **novo** (managed) |
| AI Core | `default_aicore` | — | existing |
| SDM | `document-management-standard-service` | — | existing |

> O Object Store é o único serviço novo com custo recorrente (~$0.023/GB/mês).

---

## Desenvolvimento local

### Backend
```bash
cd srv
npm install
# criar .env com variáveis locais (ou usar credenciais de um service key)
S3_ENDPOINT=... S3_ACCESS_KEY=... S3_SECRET_KEY=... S3_BUCKET=... node server.js
```

### Frontend
```bash
cd webapp
npm install
npm start   # abre http://localhost:8080, proxia /api para localhost:3000
```

### Variáveis de ambiente locais (srv/.env)

```
PORT=3000
S3_ENDPOINT=https://<object-store-endpoint>
S3_ACCESS_KEY=<access-key-id>
S3_SECRET_KEY=<secret-access-key>
S3_BUCKET=<bucket-name>
AICORE_DEPLOYMENT_ID=d7a09bc4d6d523f7
AICORE_RESOURCE_GROUP=default
```

Para SDM local, configurar `VCAP_SERVICES` com o service key da instância SDM.

---

## Deploy BTP

```bash
# na raiz do repo
npm run build:mta        # gera mta_archives/aidocparser_0.0.1.mtar
cf deploy mta_archives/aidocparser_0.0.1.mtar
```

### Checklist pós-deploy

1. Atribuir role collections no BTP Cockpit → Security → Role Collections:
   - `DocParser User` → usuários que farão upload
   - `DocParser Admin` → administradores
2. Registrar no Work Zone Channel Manager → Update content
3. Adicionar tile no Work Zone site (intent `DocParser-upload`)
4. Health check: `https://<app-url>/health`

---

## Work Zone

- **Semantic Object:** `DocParser`
- **Action:** `upload`
- **Intent hint:** `saas_approuter_aidocparser` (ajustar após primeiro deploy)
- **Ícone:** `sap-icon://upload-to-cloud`

---

## Roadmap / Pendências

| # | Item | Status |
|---|---|---|
| 1 | Testar parsers com arquivos reais (PDF nativo, PDF escaneado, Excel, Word, Imagem) | Pendente |
| 2 | Instalar `canvas` no srv para OCR de páginas PDF (renderização PNG) | Pendente |
| 3 | Provisionar `aidocparser-object-store` no BTP | Pendente |
| 4 | Fazer `npm install` em `srv/` e resolver eventuais conflitos de versão | Pendente |
| 5 | Deploy MTA end-to-end e smoke test | Pendente |
| 6 | Integração no Zilo: entidade `ParsedDocument` + link "Ver original" via presigned URL | Futura |
| 7 | Histórico de uploads por usuário (tela adicional) | Futura |
| 8 | Suporte a múltiplos repositórios SDM (config por tenant) | Futura |
| 9 | Export do markdown para download antes do upload | Futura |

---

## Decisões de design registradas

- **UI5 nativo** (não React encapsulado): Work Zone é cidadão de primeira classe no UI5, sem conflito de estilos ou dois runtimes
- **Original sempre no S3**: separação clara entre "arquivo de referência" e "conteúdo para RAG"; presigned URLs são o padrão para links de fonte
- **Parseado flexível**: mesmo app serve clientes que têm SDM (grounding automático) e clientes que querem só S3
- **Backend standalone sem CAP**: app simples de upload não precisa de OData nem CDS; Express é mais direto e mais leve
- **XSUAA próprio**: standalone completo, sem dependência do `zilo-xsuaa`; facilita deploy em outras subaccounts
- **OCR seletivo**: Vision só é chamado quando a página tem < 100 chars de texto nativo — economiza tokens
- **Ownership check em presigned**: `GET /api/documents/presigned` valida que o `key` pertence ao `userId` do JWT
