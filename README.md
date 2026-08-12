# FlowCheckout

Checkout PIX próprio com gateway [MisticPay](https://api.misticpay.com), painel
administrativo e banco Supabase. Node.js + Express, HTML/CSS/JS puro no frontend
(fonte Roboto). Sem build step. Roda local ou na Vercel.

---

## Colocando no ar

### 1. Banco (uma vez só)

Abra o **SQL Editor** do Supabase, cole o conteúdo de
[supabase/schema.sql](supabase/schema.sql) e execute. Cria tabelas, funções
atômicas, índices e liga o RLS. É idempotente — rodar de novo não quebra nada.

### 2. Variáveis

```bash
npm install
cp .env.example .env       # Windows: copy .env.example .env

npm run gen:secret         # WEBHOOK_TOKEN
npm run gen:secret         # CRON_SECRET
npm run gen:path           # ADMIN_PATH
npm run gen:key            # APP_ENCRYPTION_KEY
```

Preencha `SUPABASE_URL` e `SUPABASE_SECRET_KEY`. As credenciais da MisticPay
são opcionais aqui — você as cadastra pelo painel, na aba **Configurações**.

> **A chave do Supabase tem que ser a secreta** (`sb_secret_…` / `service_role`),
> não a publishable. A publishable é a chave pública do browser e respeita RLS —
> com ela nada funciona. A aplicação recusa iniciar se detectar a chave errada.

### 3. Conferir e criar seu acesso

```bash
npm run db:check           # diz exatamente o que falta, se faltar algo
npm run admin:create       # cria o usuário do painel (senha + 2FA)
npm start
```

Checkout em <http://localhost:3000>, painel em `http://localhost:3000/<ADMIN_PATH>/`.

### 4. Vercel

Importe o repositório. Em **Settings → Environment Variables**, cadastre as mesmas
variáveis do `.env` — com `PUBLIC_URL` apontando para o domínio final
(`https://seu-projeto.vercel.app`), senão a URL do webhook sai errada.

O [vercel.json](vercel.json) já manda todas as rotas para a função e agenda a
limpeza diária. Depois do primeiro deploy, cadastre a URL do webhook na MisticPay:

```
https://SEU-DOMINIO/api/webhooks/misticpay/<WEBHOOK_TOKEN>
```

---

## Por que serverless mudou a arquitetura

Na Vercel não existe processo de longa duração: cada requisição pode cair numa
instância nova, e a memória some entre elas. Três coisas que funcionavam em
memória tiveram que ir para o Postgres:

| Antes (em memória) | Por que quebraria | Agora |
|---|---|---|
| Sessões do painel | Você cairia do painel a cada clique | `admin_sessions` (guarda só o SHA-256 do token) |
| Bloqueio de força bruta | **Falha silenciosa e grave**: o atacante ganharia tentativas ilimitadas, já que cada instância começa a contar do zero | `auth_attempts` + função SQL atômica |
| Rate limit do checkout | Mesmo problema | `rate_limits` + `bump_rate_limit()` |
| `setInterval` de limpeza | Nunca rodaria | Vercel Cron → `/api/cron/cleanup` |

As decisões de "pode passar?" viram **uma função SQL só**, numa transação. Ler,
decidir e escrever em três viagens abriria janela de corrida — duas requisições
simultâneas furariam o mesmo limite.

A idempotência do pagamento seguiu o mesmo caminho: `markOrderPaidOnce` faz
`UPDATE … WHERE paid = false`. Se o webhook e o polling chegarem juntos, em
instâncias diferentes, o Postgres decide quem ganha — só um recebe a linha de
volta, e só um entrega o produto.

---

## Fluxo do pagamento

```
Browser                    Seu servidor                     MisticPay
   │                            │                                │
   │ POST /api/checkout/pix     │                                │
   ├───────────────────────────►│                                │
   │                            │ valida dados + pega preço      │
   │                            │ do banco (nunca do body)       │
   │                            │ POST /transactions/create      │
   │                            ├───────────────────────────────►│
   │◄───────────────────────────┤ QR Code + copia e cola         │
   │                            │                                │
   │ GET /:id/status (4 em 4s)  │                                │
   ├───────────────────────────►│ POST /transactions/check       │
   │                            ├───────────────────────────────►│
   │                            │                                │
   │                            │◄──── POST webhook (COMPLETO) ──┤
   │                            │ reconsulta /check p/ confirmar │
   │                            │ marca pago + entrega o produto │
   │◄─── paid: true ────────────┤                                │
```

---

## Segurança

### Checkout

| Risco | Como está tratado |
|---|---|
| Vazamento de credenciais | `ci`/`cs` da MisticPay e a chave secreta do Supabase só existem no servidor. O browser fala apenas com `/api/checkout`. |
| Adulteração de preço | O front envia só o `productId`. O valor vem da tabela `products`, em centavos, no servidor. |
| Webhook forjado | Token secreto no path **e** — o que realmente protege — o webhook nunca aprova sozinho: dispara uma reconsulta a `/transactions/check`, que é a fonte da verdade. |
| Entrega duplicada | `UPDATE … WHERE paid = false` no Postgres. Resolve corrida entre instâncias, não só entre chamadas. |
| Rate limit do gateway | Máximo 1 consulta a cada 4s por pedido, com recuo em 429. A rota `/transactions/check` permite 60 req/min por IP. |
| Abuso do checkout | 8 PIX/min por IP na criação, 90 req/min na consulta de status. |
| Dados inválidos | CPF e CNPJ validados com dígito verificador no cliente **e** no servidor. |

### Painel

O painel fica num caminho secreto (`ADMIN_PATH`), e opcionalmente restrito a um
host (`ADMIN_HOST`) e a uma lista de IPs (`ADMIN_IP_ALLOWLIST`). Fora disso, 404.

**Obscuridade não é a proteção.** Subdomínio vaza por Certificate Transparency
(todo certificado TLS emitido é público e indexado em `crt.sh`), por DNS passivo e
por cabeçalho `Referer`. Um pentester encontra em minutos. O caminho secreto corta
ruído de scanner automático; quem segura invasor é a camada abaixo:

| Camada | O que faz |
|---|---|
| Senha | scrypt (N=32768), salt por usuário. Mínimo 12 caracteres com maiúscula, minúscula, número e símbolo. |
| Segundo fator | TOTP obrigatório. Código já usado não vale de novo, nem dentro da janela de 30s. |
| Bloqueio progressivo | 5 falhas → 1 min; 8 → 5 min; 12 → 30 min; 20 → 6 h. Conta por IP **e** por usuário, então trocar um dos dois não contorna. |
| Enumeração de usuário | Usuário inexistente, senha errada e 2FA errado devolvem a mesma mensagem, e o scrypt roda mesmo quando o usuário não existe, para o tempo de resposta não entregar nada. |
| Sessão | Cookie `HttpOnly`, `SameSite=Strict`, `Secure` fora de localhost, escopo no caminho secreto. Expira com 30 min ocioso ou 12 h absolutas. No banco guardamos só o SHA-256 do token — um dump não entrega cookies utilizáveis. |
| Cookie roubado | Sessão amarrada ao IP e ao User-Agent. Usada de outra máquina, é destruída e o evento vai para a auditoria. |
| CSRF | Token por sessão, exigido num header custom (que form cross-site não consegue enviar), somado ao `SameSite=Strict`. |
| XSS | CSP sem `unsafe-inline`; todo dado vindo do servidor passa por escape antes de entrar no DOM. |
| Dados pessoais | CPF, e-mail e telefone aparecem mascarados. Ver o valor completo exige ação explícita, registrada na auditoria — assim como a exportação CSV. |
| Vazamento por cache | `no-store`, `no-referrer` e `X-Robots-Tag: noindex` em todas as respostas do painel. |
| CSV | Campos começando com `=`, `+`, `-` ou `@` são neutralizados (formula injection no Excel). |
| Banco | RLS ligado **sem policies** em todas as tabelas. A chave publishable não lê nem escreve nada; só a service_role, que vive no servidor. |

### Gateways de pagamento

Dois integrados, escolhidos na aba **Configurações** do painel:

| Gateway | Autenticação | QR Code |
|---|---|---|
| **MisticPay** | headers `ci`/`cs` a cada requisição | vem pronto do gateway |
| **SyncPay** | `client_id`/`client_secret` trocados por Bearer token de 1 h (cacheado) | só o copia e cola; o QR é gerado aqui |

A SyncPay devolve apenas o `pix_code`. A imagem do QR vem do `api.qrserver.com`
(mesmo serviço que a MisticPay usa no campo `qrcodeUrl` dela). Quem baixa é o
navegador do cliente, então o código Pix passa por esse serviço — ele não move
dinheiro sozinho, só identifica a cobrança, mas é um dado da transação saindo
para um terceiro.

Se preferir manter tudo interno, ponha `QRCODE_PROVIDER=local` no ambiente: a
imagem passa a ser gerada no servidor pela biblioteca `qrcode`, sem chamada
externa. Ver [src/qrcode.js](src/qrcode.js).

**Trocar o gateway ativo afeta só as cobranças novas.** Cada pedido guarda em
`orders.gateway` quem o processou, e continua sendo conferido lá. Sem isso, uma
troca deixaria todo PIX pendente órfão — o sistema perguntaria ao gateway novo
por uma transação que só existe no antigo.

Duas travas na troca: o painel recusa ativar um gateway sem credenciais, e testa
as credenciais salvas contra a API antes de efetivar. Ativar um gateway que não
responde derrubaria todas as vendas de uma vez.

**Para adicionar um terceiro gateway:** escreva um módulo em `src/gateways/` com
a mesma interface (`testCredentials`, `createPixCharge`, `checkTransaction`,
`getBalance`, `parseWebhook`, `credentialFields`) e registre em
[src/gateways/index.js](src/gateways/index.js). Nada mais muda — nem o painel,
que monta os formulários a partir de `credentialFields`.

### Credenciais do gateway

Ficam na aba **Configurações** do painel, não no `.env`. Trocar não exige deploy.

O Client Secret é gravado cifrado com **AES-256-GCM**, e a chave de cifra
(`APP_ENCRYPTION_KEY`) vive nas variáveis de ambiente — **fora do banco**. Um dump
do Postgres sozinho (backup mal guardado, acesso indevido ao Supabase) não entrega
as credenciais de pagamento.

Outras garantias:

- O secret **nunca volta para o browser**. O painel só sabe que ele existe.
- Antes de salvar, as credenciais são validadas contra `/users/info` da MisticPay.
  Chave inválida não chega ao banco — salvar uma quebraria as vendas em silêncio.
- Deixar o campo Secret em branco mantém o atual, para corrigir só o Client ID.
- Toda alteração vai para a auditoria, com quem e de qual IP. A credencial em si
  nunca é registrada.
- Sem `APP_ENCRYPTION_KEY` configurada, o painel **recusa salvar** em vez de gravar
  em texto claro.

Instâncias já aquecidas levam até 30 s para pegar a credencial nova (cache curto,
para não consultar o banco a cada cobrança).

### Recuperação de acesso

Não existe "esqueci minha senha" — de propósito, já que fluxo de recuperação por
e-mail é o caminho mais comum para invadir painel. Perdeu a chave 2FA, rode
`npm run admin:create` com o mesmo usuário e confirme com `SIM`.

### Segredos fora do repositório

Duas camadas:

1. **`.gitignore`** mantém `.env` fora do git.
2. **Hook de pre-commit** ([.githooks/pre-commit](.githooks/pre-commit)) bloqueia o
   commit se um segredo escapar — inclusive por `git add -f`, arquivo renomeado, ou
   chave colada dentro de um `.js`. Detecta chave secreta do Supabase, JWT
   `service_role`, `APP_ENCRYPTION_KEY`, `WEBHOOK_TOKEN`, `CRON_SECRET` e credenciais
   da MisticPay com valor real preenchido.

O hook não é instalado automaticamente ao clonar (o git não permite, por segurança).
Depois de clonar, rode:

```bash
npm run hooks:install
```

Para pular num caso legítimo: `git commit --no-verify`.

### Endurecendo mais

1. **`ADMIN_IP_ALLOWLIST` é a defesa mais forte** disponível aqui. Se tem IP fixo
   ou VPN, use — corta ataque remoto antes de chegar na senha.
2. **Rotacione as chaves** do Supabase e da MisticPay se elas passaram por algum
   canal não confiável (chat, e-mail, print).
3. **Nunca commite o `.env`.** Na Vercel, use Environment Variables.
4. **Confira o `trust proxy`** em [src/app.js](src/app.js): com ele errado, `req.ip`
   vira o IP do proxy e o bloqueio por tentativas e a allowlist param de funcionar.

---

## Estrutura

```
api/index.js               entrada da Vercel (exporta o app)
server.js                  entrada local (app.listen)
vercel.json                rotas, função e cron
supabase/schema.sql        DDL, funções atômicas, RLS

src/
  app.js                   monta o Express (usado pelas duas entradas)
  config.js                env vars — falha rápido e explica o que falta
  supabase.js              cliente PostgREST em fetch puro (sem dependência)
  audit.js                 registro de ações administrativas
  products.js              catálogo e preços — a fonte da verdade do valor
  store.js                 pedidos
  orders.js                sincronização de status e entrega
  validators.js            CPF/CNPJ/e-mail/telefone
  crypto-utils.js          scrypt, TOTP, comparação em tempo constante
  misticpay.js             cliente do gateway (timeout + retry)
  rate-limit.js            limitador por IP, contado no banco
  routes/checkout.js       POST /pix, GET /:id/status, GET /product
  routes/webhook.js        POST /webhooks/misticpay/:token
  routes/cron.js           GET /cron/cleanup
  admin/auth.js            sessões, 2FA, CSRF, bloqueio, guards de host/IP
  admin/routes.js          API do painel

admin-ui/                  interface do painel — fora de public/, nunca servida
  login.html  app.html     pelo site público, só pela rota secreta autenticada
  assets/

public/                    site público do checkout
scripts/create-admin.js    cria/redefine o administrador
scripts/check-db.js        diagnóstico da conexão e do schema
```

---

## O que ainda falta para produção

1. **Implementar a entrega.** `fulfillOrder()` em
   [src/orders.js](src/orders.js) é onde você libera o acesso, dispara o e-mail ou
   cria o usuário na área de membros. Hoje só faz log.

2. **Cadastrar seus produtos** pelo painel. Cada produto tem link próprio
   (`/?produto=<id>`), copiável direto da lista.

   **Tela de obrigado por produto:** título, mensagem e um botão opcional de
   acesso, no mesmo formulário. Vazio usa o texto padrão. Na mensagem,
   `{email}`, `{pedido}` e `{valor}` viram os dados reais da compra.

   Duas travas, porque esse texto é escrito no painel e exibido no navegador de
   quem acabou de pagar: a mensagem entra por `textContent` (nunca `innerHTML`),
   e o link do botão só aceita `https://` — validado no servidor **e** por
   constraint no Postgres. Um `javascript:` ali viraria execução de script na
   tela do comprador.

   O botão é o caminho mais curto para entregar de fato: aponte para a área de
   membros, o grupo de WhatsApp ou o download, e o comprador sai da tela com o
   produto em mãos, sem depender de e-mail.

3. **Tratar MEDs.** Contestações chegam pelo webhook com `event: "INFRACTION"` e
   hoje só geram log de alerta e marcação no pedido. O prazo de defesa é curto e
   cada infração aceita **uma única** resposta — vale plugar um alerta.

4. **Backup do Supabase.** A tabela `orders` tem dados pessoais de compradores.

---

## Cartão de crédito

A API da MisticPay processa **apenas PIX** (cash-in PIX, cash-out PIX e cripto).
Não existe endpoint de cartão na documentação.

A opção aparece na tela como no layout, marcada como *Indisponível*. Quando
contratar um gateway de cartão, mude `methods.card` para `true` em
[src/routes/checkout.js](src/routes/checkout.js) e adicione a rota — o front já
trata o método selecionado.

---

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/checkout/product?id=` | Dados do produto para o resumo |
| `POST` | `/api/checkout/pix` | Cria a cobrança, devolve QR Code + copia e cola |
| `GET` | `/api/checkout/:orderId/status` | Status do pedido (polling) |
| `POST` | `/api/webhooks/misticpay/:token` | Notificações do gateway |
| `GET` | `/api/cron/cleanup` | Limpeza agendada (exige `CRON_SECRET`) |
| `GET` | `/api/health` | Healthcheck + estado do banco |

Painel — sob `/<ADMIN_PATH>`, exigindo sessão e CSRF (exceto o login):

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/login` | Usuário + senha + TOTP |
| `GET` | `/api/session` | Dados da sessão e token CSRF |
| `GET` | `/api/overview` | Receita, conversão, série de 14 dias, ranking |
| `GET` `POST` | `/api/products` | Listar e criar |
| `PATCH` `DELETE` | `/api/products/:id` | Editar e excluir/desativar |
| `GET` | `/api/orders` | Vendas com filtro, busca e paginação |
| `POST` | `/api/orders/:id/reveal` | Exibe dados pessoais completos (auditado) |
| `POST` | `/api/orders/:id/recheck` | Força reconsulta no gateway |
| `GET` | `/api/orders/export/csv` | Exporta vendas (auditado) |
| `GET` | `/api/audit` | Registro de acessos e ações |
| `POST` | `/api/sessions/revoke` | Encerra as outras sessões ativas |
