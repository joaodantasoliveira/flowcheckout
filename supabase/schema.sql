-- =============================================================
--  Checkout PIX — schema do Supabase
--
--  Rode este arquivo inteiro no SQL Editor do Supabase.
--  É idempotente: pode rodar de novo sem quebrar nada.
--
--  IMPORTANTE: RLS fica LIGADO e SEM POLÍTICAS em todas as tabelas.
--  Isso é intencional. Significa que a chave publishable (a que fica
--  exposta no browser) NÃO consegue ler nem escrever nada aqui.
--  Só a chave secreta (service_role), que vive apenas no servidor,
--  passa pelo RLS. Sem isso, qualquer pessoa leria os dados dos seus
--  compradores e os hashes de senha do painel.
-- =============================================================

-- -------------------------------------------------------------
--  PRODUTOS
-- -------------------------------------------------------------
create table if not exists public.products (
  id                text        primary key,
  name              text        not null,
  subtitle          text        not null default '',
  image             text        not null default '/img/produto.svg',
  price_cents       bigint      not null check (price_cents >= 100),
  max_installments  smallint    not null default 1 check (max_installments between 1 and 12),
  active            boolean     not null default true,

  -- Tela de obrigado, personalizável por produto. Vazio usa o texto padrão.
  success_title        text,
  success_message      text,
  success_button_label text,
  success_button_url   text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint products_success_len check (
    coalesce(length(success_title), 0)        <= 80  and
    coalesce(length(success_message), 0)      <= 600 and
    coalesce(length(success_button_label), 0) <= 40  and
    coalesce(length(success_button_url), 0)   <= 500
  ),

  -- Só https: javascript: e data: viram XSS na tela de confirmação.
  constraint products_success_url_https check (
    success_button_url is null
    or success_button_url = ''
    or success_button_url ~ '^https://'
  )
);

create index if not exists products_active_idx on public.products (active, created_at);

-- -------------------------------------------------------------
--  PEDIDOS
-- -------------------------------------------------------------
create table if not exists public.orders (
  id                      text        primary key,
  reference               text        not null unique,
  gateway_transaction_id  text        unique,

  product_id              text        not null,
  product_name            text        not null,
  amount_cents            bigint      not null,

  -- Dados pessoais do comprador (LGPD: acesso auditado na aplicação).
  customer_name           text        not null,
  customer_email          text        not null,
  customer_document       text        not null,
  customer_phone          text        not null,

  status                  text        not null default 'PENDENTE'
                                      check (status in ('PENDENTE','COMPLETO','FALHA','CANCELADO')),
  paid                    boolean     not null default false,
  paid_at                 timestamptz,
  end_to_end_id           text,
  fulfilled               boolean     not null default false,

  pix                     jsonb,
  infraction              jsonb,
  meta                    jsonb,

  last_gateway_poll_at    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists orders_created_idx  on public.orders (created_at desc);
create index if not exists orders_status_idx   on public.orders (status, created_at desc);
create index if not exists orders_paid_idx     on public.orders (paid, paid_at desc);
create index if not exists orders_product_idx  on public.orders (product_id);
create index if not exists orders_gateway_idx  on public.orders (gateway_transaction_id);

-- -------------------------------------------------------------
--  ADMINISTRADORES
-- -------------------------------------------------------------
create table if not exists public.admins (
  id                 uuid        primary key default gen_random_uuid(),
  username           text        not null unique,
  name               text        not null,
  password_hash      text        not null,   -- scrypt, salt por usuário
  totp_secret        text        not null,   -- base32
  last_totp_counter  bigint      not null default 0,
  active             boolean     not null default true,
  last_login_at      timestamptz,
  last_login_ip      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- -------------------------------------------------------------
--  SESSÕES DO PAINEL
--
--  Guardamos apenas o SHA-256 do token. Um dump do banco não entrega
--  cookies de sessão utilizáveis.
-- -------------------------------------------------------------
create table if not exists public.admin_sessions (
  token_hash    text        primary key,
  admin_id      uuid        not null references public.admins(id) on delete cascade,
  csrf          text        not null,
  ip            text        not null,
  user_agent    text        not null default '',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists admin_sessions_admin_idx on public.admin_sessions (admin_id);
create index if not exists admin_sessions_seen_idx  on public.admin_sessions (last_seen_at);

-- -------------------------------------------------------------
--  CONTROLE DE TENTATIVAS E RATE LIMIT
--
--  Precisa viver no banco: em serverless não existe memória
--  compartilhada entre invocações, e um contador em memória daria
--  tentativas ilimitadas ao atacante.
-- -------------------------------------------------------------
create table if not exists public.auth_attempts (
  key         text        primary key,
  fail_count  integer     not null default 0,
  locked_until timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists public.rate_limits (
  key          text        primary key,
  hits         integer     not null default 0,
  window_start timestamptz not null default now()
);

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- -------------------------------------------------------------
--  CONFIGURAÇÕES (credenciais do gateway, editáveis pelo painel)
--
--  `secret` guarda valores cifrados com AES-256-GCM pela aplicação.
--  A chave de criptografia vive em APP_ENCRYPTION_KEY, fora do banco:
--  um dump do Postgres sozinho não entrega credenciais de pagamento.
-- -------------------------------------------------------------
create table if not exists public.settings (
  key         text        primary key,
  value       text,
  secret      text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- -------------------------------------------------------------
--  AUDITORIA
-- -------------------------------------------------------------
create table if not exists public.audit_log (
  id        bigserial   primary key,
  at        timestamptz not null default now(),
  action    text        not null,
  admin_id  uuid,
  ip        text,
  detail    jsonb
);

create index if not exists audit_at_idx on public.audit_log (at desc);

-- =============================================================
--  FUNÇÕES ATÔMICAS
--
--  Ler-decidir-escrever em três round trips abriria janela de corrida:
--  duas requisições simultâneas passariam pelo mesmo limite. Estas
--  funções resolvem tudo numa transação só.
-- =============================================================

-- Rate limit de janela fixa. Devolve se pode passar e quanto falta.
create or replace function public.bump_rate_limit(
  p_key       text,
  p_window_ms integer,
  p_max       integer
)
returns table (allowed boolean, retry_after integer)
language plpgsql
as $$
declare
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
  v_hits   integer;
  v_start  timestamptz;
begin
  insert into public.rate_limits (key, hits, window_start)
    values (p_key, 1, now())
  on conflict (key) do update
    set hits = case
                 when public.rate_limits.window_start < now() - v_window then 1
                 else public.rate_limits.hits + 1
               end,
        window_start = case
                 when public.rate_limits.window_start < now() - v_window then now()
                 else public.rate_limits.window_start
               end
  returning public.rate_limits.hits, public.rate_limits.window_start
    into v_hits, v_start;

  if v_hits > p_max then
    return query select false, greatest(1, ceil(extract(epoch from (v_start + v_window - now())))::integer);
  end if;

  return query select true, 0;
end;
$$;

-- Verifica se a chave está bloqueada por excesso de falhas de login.
create or replace function public.check_auth_lock(p_key text)
returns table (locked boolean, retry_after integer)
language plpgsql
as $$
declare
  v_until timestamptz;
begin
  select locked_until into v_until from public.auth_attempts where key = p_key;

  if v_until is not null and v_until > now() then
    return query select true, greatest(1, ceil(extract(epoch from (v_until - now())))::integer);
  end if;

  return query select false, 0;
end;
$$;

-- Registra uma falha e aplica o bloqueio progressivo.
create or replace function public.register_auth_failure(p_key text)
returns void
language plpgsql
as $$
declare
  v_count integer;
  v_lock  interval;
begin
  insert into public.auth_attempts (key, fail_count, updated_at)
    values (p_key, 1, now())
  on conflict (key) do update
    set fail_count = public.auth_attempts.fail_count + 1,
        updated_at = now()
  returning fail_count into v_count;

  v_lock := case
    when v_count >= 20 then interval '6 hours'
    when v_count >= 12 then interval '30 minutes'
    when v_count >= 8  then interval '5 minutes'
    when v_count >= 5  then interval '1 minute'
    else null
  end;

  if v_lock is not null then
    update public.auth_attempts set locked_until = now() + v_lock where key = p_key;
  end if;
end;
$$;

create or replace function public.clear_auth_failures(p_key text)
returns void
language sql
as $$
  delete from public.auth_attempts where key = p_key;
$$;

-- Limpeza periódica (chamada pelo cron da Vercel).
create or replace function public.cleanup_expired()
returns table (sessions_removed integer, orders_removed integer, rates_removed integer)
language plpgsql
as $$
declare
  v_sessions integer;
  v_orders   integer;
  v_rates    integer;
begin
  -- Sessão: 30 min ociosa ou 12 h absolutas.
  with gone as (
    delete from public.admin_sessions
     where last_seen_at < now() - interval '30 minutes'
        or created_at   < now() - interval '12 hours'
    returning 1
  ) select count(*)::integer into v_sessions from gone;

  -- Pedidos não pagos com mais de 7 dias são formulário abandonado.
  -- Pedido PAGO nunca é removido: é o histórico financeiro.
  with gone as (
    delete from public.orders
     where paid = false and updated_at < now() - interval '7 days'
    returning 1
  ) select count(*)::integer into v_orders from gone;

  with gone as (
    delete from public.rate_limits where window_start < now() - interval '1 day'
    returning 1
  ) select count(*)::integer into v_rates from gone;

  delete from public.auth_attempts
   where updated_at < now() - interval '1 day'
     and (locked_until is null or locked_until < now());

  -- Mantém a auditoria enxuta.
  delete from public.audit_log
   where id < (select coalesce(max(id), 0) - 5000 from public.audit_log);

  return query select v_sessions, v_orders, v_rates;
end;
$$;

-- =============================================================
--  RLS — trancado para todas as chaves públicas
-- =============================================================
alter table public.products       enable row level security;
alter table public.orders         enable row level security;
alter table public.admins         enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.auth_attempts  enable row level security;
alter table public.rate_limits    enable row level security;
alter table public.audit_log      enable row level security;
alter table public.settings       enable row level security;

-- Nenhuma policy é criada de propósito: sem policy, RLS nega tudo.
-- A chave service_role ignora RLS e é a única que a aplicação usa.

-- Tira o schema do alcance das chaves anônimas também no nível de grant.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- -------------------------------------------------------------
--  Produto de exemplo (não sobrescreve se já existir)
-- -------------------------------------------------------------
insert into public.products (id, name, subtitle, image, price_cents, max_installments, active)
values (
  'nova-alianca-divergente',
  'Nova Aliança Divergente | À Vista',
  'Pagamento único',
  '/img/produto.svg',
  699300, 1, true
)
on conflict (id) do nothing;
