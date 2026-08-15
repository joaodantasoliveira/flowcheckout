-- =============================================================
--  Migração 008 — visitas na página de checkout
--
--  Rode no SQL Editor do Supabase.
--
--  Sem isto o funil começava em "checkout iniciado" e escondia a
--  maior perda de todas: quem abre a página e vai embora sem
--  preencher nada. É onde mora a maior parte do dinheiro.
-- =============================================================

create table if not exists public.page_views (
  id          bigserial   primary key,
  product_id  text        not null,
  -- Identificador da aba do visitante. Uma visita por sessão evita
  -- que recarregar a página vire 5 visitas e infle o topo do funil.
  session_id  text        not null,
  tracking    jsonb,
  created_at  timestamptz not null default now(),

  constraint page_views_session_unica unique (product_id, session_id)
);

create index if not exists page_views_created_idx on public.page_views (created_at desc);
create index if not exists page_views_product_idx on public.page_views (product_id, created_at desc);

alter table public.page_views enable row level security;
revoke all on public.page_views from anon, authenticated;

-- -------------------------------------------------------------
--  Limpeza: visita é dado de funil, não histórico financeiro.
--  Guardar 90 dias basta e mantém a tabela leve.
-- -------------------------------------------------------------
create or replace function public.cleanup_expired()
returns table (sessions_removed integer, orders_removed integer, rates_removed integer)
language plpgsql
as $$
declare
  v_sessions integer;
  v_orders   integer;
  v_rates    integer;
begin
  with gone as (
    delete from public.admin_sessions
     where last_seen_at < now() - interval '30 minutes'
        or created_at   < now() - interval '12 hours'
    returning 1
  ) select count(*)::integer into v_sessions from gone;

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

  delete from public.page_views where created_at < now() - interval '90 days';

  delete from public.audit_log
   where id < (select coalesce(max(id), 0) - 5000 from public.audit_log);

  return query select v_sessions, v_orders, v_rates;
end;
$$;
