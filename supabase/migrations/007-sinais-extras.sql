-- =============================================================
--  Migração 007 — sinais extras de identificação
--
--  Rode no SQL Editor do Supabase.
--
--  CEP é o parâmetro de maior peso que ainda não coletávamos. Dele
--  saem três sinais de uma vez: zp, ct (cidade) e st (estado) — os
--  dois últimos derivados por consulta, não digitados, então chegam
--  corretos ao Meta.
--
--  Fica OPCIONAL por produto: campo a mais no checkout cobra em
--  conversão, e a troca só compensa se você vive de otimizar campanha.
-- =============================================================

alter table public.products
  add column if not exists ask_zip boolean not null default false;

alter table public.orders
  add column if not exists customer_zip text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_zip_formato'
  ) then
    alter table public.orders add constraint orders_zip_formato
      check (customer_zip is null or customer_zip ~ '^[0-9]{8}$');
  end if;
end $$;
