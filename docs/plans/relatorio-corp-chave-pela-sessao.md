# Relatorio IAF-919: chave corporativa pela sessao do central

## Resumo

Nova rota `POST /api/v1/me/chave-corporativa`: confirma o token de sessao desktop no central da esteira (`ESTEIRA_CENTRAL_URL`) e devolve a chave corporativa do usuario, rotacionando so quando a chave nao e recuperavel (so-hash). Branch `feat/corp-chave-pela-sessao`, base `fd71f0b68` (sobre `release/v3.8.51`).

## SHAs

- fdd81c4fd feat(api): rota chave-corporativa
- 172039d8b docs(api): rota e ESTEIRA_CENTRAL_URL
- 683c2b839 fix(api): endurecimento (limiters, trava de rotacao, teto de corpo, validacao de e-mail/URL)
- Fechamento: commit `docs(api)` desta etapa (ver `git log -1`)

## Arquivos

`src/app/api/v1/me/chave-corporativa/route.ts`, `src/lib/corp/esteiraCentral.ts`, `src/lib/corp/tentativasLimiter.ts`, `src/lib/db/apiKeys.ts`, `src/server/authz/classify.ts`, `open-sse/utils/error.ts`, `tests/unit/api/v1-me-chave-corporativa-route.test.ts`, `docs/openapi.yaml`, `docs/reference/API_REFERENCE.md`, `docs/reference/ENVIRONMENT.md`.

## Gates (rodados no fechamento)

| Gate                                                           | Resultado                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/api/v1-me-chave-corporativa-route.test.ts`         | 30/30 passam                                                                                                                                                                                                                                                           |
| vizinhos `tests/unit/authz/*`, `authz*.test.ts`, `api/v1-me-*` | 348 passam, 1 falha: `tests/unit/authz/probe-9033-repro.test.ts` (TypeError "path" undefined: depende do `DATA_DIR` que o `isolateDataDir` injeta pelo runner `npm run test:unit`; falha na linha 13, antes de qualquer código da rota; ambiental, fora do nosso diff) |
| `npm run typecheck:core`                                       | exit 0                                                                                                                                                                                                                                                                 |
| `npm run lint`                                                 | exit 2, somente "suppressions left that do not occur anymore"; `eslint --pass-on-unpruned-suppressions` sem erros reais. Herdado (ver abaixo)                                                                                                                          |
| `npm run check:docs-all`                                       | falha apenas em `check:env-doc-sync` (esperada: `ESTEIRA_CENTRAL_URL`, `NODE_EXTRA_CA_CERTS` + `CATALOG_CACHE_MAX_BYTES`, `CATALOG_CACHE_MAX_ENTRIES`, `OMNIROUTE_MODEL_PERMISSION_CACHE_MAX` pre-existentes)                                                          |

### Lint: supressoes orfas sao herdadas

Copia de `config/quality/eslint-suppressions.json` podada em `_artifacts/` (`--prune-suppressions`, original intacto). Orfas: `open-sse/translator/request/openai-to-cursor.ts` (3), `SystemStorageTab.tsx` (1), `src/lib/oauth/providers/ghe-copilot.ts` (1), `tests/unit/cursor-agent-session.test.ts` (1). Nenhum desses arquivos esta em `git diff fd71f0b68..HEAD`; o arquivo de supressoes nao foi alterado. Os 3 `no-unused-vars` de `src/lib/db/apiKeys.ts` continuam suprimidos (count 3, ja existente em `fd71f0b68`) e nao geram erro.

## Revisoes

- Carrasco: 6 achados, nota 8; rechecagem APROVADA (nota 9). O agregador marca BLOCK so por 2 Low: teto global esgotavel por quem nao tem sessao (aceito, e a troca do A1) e docs (corrigido neste fechamento).
- Critico de seguranca (nota 7): S1 Medium (e-mail do central sem validacao) corrigido; S2 Low (URL http/query) corrigido, ambos em 683c2b839.
- Desfechos por achado em `.harness/reviews/corp-chave-pela-sessao/achados.json` e `achados-seguranca.json`: A1-A6, S1, S2 corrigidos (A1 com residual Low aceito: teto global esgotável por quem não tem sessão).

## Decisoes

- Trabalho direto no checkout (clone dedicado da VM, branch criada pelo orquestrador a partir de `release/v3.8.51`).
- "So hash": o banco sempre grava `key` e `key_hash`; so-hash = `key` vazia, igual a `key_hash` ou 64 hex. Na pratica quase toda chave e "em texto" e volta 200 sem rotacionar. Ponto de atencao para o Iguacu Flow.
- Excecao PUBLIC apenas no caminho exato em `classify.ts`.
- Codigos fora do contrato: 400 `corpo_invalido`, 413 `corpo_grande`, 429 `muitas_tentativas`, 500 `erro_interno`.
- E-mail invalido vindo do central -> 503 `central_indisponivel`.
- Limites (IP 20/min, e-mail 10/min, hash do token 10/min, global 120/min) e mutex de rotacao sao em memoria, por processo, nao compartilhados entre replicas.
- Colisao entre dominios aceita por ser a regra do contrato.

## Pendencias

- `.env.example`: o orquestrador aplica o bloco do passo 0 na implantacao (nao e bloqueio). Ate la `check:env-doc-sync` falha como esperado. `ESTEIRA_CENTRAL_URL` ja esta documentada em `docs/reference/ENVIRONMENT.md`.
- A4: sem asserção automatica da linha de log.
- Lint: 4 supressoes orfas herdadas da base (podar em PR proprio de base-red); falha herdada `probe-9033-repro`.

## Roteiro de implantacao

0. Acrescentar ao `.env.example` (feito pelo orquestrador):

   ```
   # URL https do central da esteira, sem barra final; usada por POST /api/v1/me/chave-corporativa
   # ESTEIRA_CENTRAL_URL=https://central.example.com
   # So se o central usar CA interna
   # NODE_EXTRA_CA_CERTS=/caminho/para/ca-interna.pem
   ```

1. Definir `ESTEIRA_CENTRAL_URL` (https) e, se o central usar CA interna, `NODE_EXTRA_CA_CERTS`.
2. Garantir proxy confiavel repassando o IP real.
3. Implantar o OmniRoute.
4. Conferir com `curl` sem token: 401 `sessao_invalida` e `Cache-Control: no-store`.
5. So entao liberar o Iguacu Flow.
