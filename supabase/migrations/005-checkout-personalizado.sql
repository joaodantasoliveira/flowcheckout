-- =============================================================
--  Migração 005 — checkout personalizável por produto
--
--  Rode no SQL Editor do Supabase.
--
--  Cada produto decide o que aparece na sua página de checkout:
--  quais formas de pagamento, o título e o selo de segurança.
-- =============================================================

alter table public.products
  add column if not exists method_pix        boolean not null default true,
  add column if not exists method_card       boolean not null default false,
  add column if not exists checkout_headline text,
  add column if not exists show_security_seal boolean not null default true;

do $$
begin
  -- Um produto sem nenhuma forma de pagamento não pode ser vendido.
  -- Melhor barrar no banco do que descobrir pelo cliente na tela vazia.
  if not exists (
    select 1 from pg_constraint where conname = 'products_ao_menos_um_metodo'
  ) then
    alter table public.products add constraint products_ao_menos_um_metodo
      check (method_pix or method_card);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'products_headline_len'
  ) then
    alter table public.products add constraint products_headline_len
      check (coalesce(length(checkout_headline), 0) <= 60);
  end if;
end $$;
