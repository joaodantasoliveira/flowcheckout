-- =============================================================
--  Migração 009 — visita na página de vendas
--
--  Rode no SQL Editor do Supabase.
--
--  A landing fica em outro domínio, então a visita dela chega por
--  uma requisição do navegador do visitante. `source` separa as duas
--  pontas do funil: quem viu a oferta e quem chegou no checkout.
-- =============================================================

alter table public.page_views
  add column if not exists source text not null default 'checkout';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'page_views_source_valida'
  ) then
    alter table public.page_views add constraint page_views_source_valida
      check (source in ('landing', 'checkout'));
  end if;
end $$;

-- A unicidade agora é por origem: a MESMA pessoa conta uma vez na landing
-- e uma vez no checkout. Sem isso a segunda visita seria descartada e a
-- passagem de uma etapa para a outra ficaria invisível.
alter table public.page_views
  drop constraint if exists page_views_session_unica;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'page_views_sessao_origem_unica'
  ) then
    alter table public.page_views add constraint page_views_sessao_origem_unica
      unique (product_id, session_id, source);
  end if;
end $$;

create index if not exists page_views_source_idx on public.page_views (source, created_at desc);
