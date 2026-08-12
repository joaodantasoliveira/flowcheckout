-- =============================================================
--  Migração 002 — configurações do gateway editáveis pelo painel
--
--  Rode no SQL Editor do Supabase se você já aplicou o schema.sql
--  antes desta versão. Em instalação nova, o schema.sql já inclui isso.
--
--  Os valores sensíveis (client secret da MisticPay) são gravados
--  CRIPTOGRAFADOS pela aplicação, com AES-256-GCM. A chave de
--  criptografia vive em APP_ENCRYPTION_KEY, fora do banco — assim um
--  dump do Postgres sozinho não entrega as credenciais de pagamento.
-- =============================================================

create table if not exists public.settings (
  key         text        primary key,
  value       text,                          -- texto claro (não sensível)
  secret      text,                          -- AES-256-GCM (sensível)
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

alter table public.settings enable row level security;

revoke all on public.settings from anon, authenticated;
