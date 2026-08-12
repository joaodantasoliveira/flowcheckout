-- =============================================================
--  Migração 004 — tela de obrigado personalizada por produto
--
--  Rode no SQL Editor do Supabase.
--
--  Cada produto passa a ter seu próprio texto de confirmação e,
--  opcionalmente, um botão de acesso. Campos vazios caem no texto
--  padrão, então produtos já cadastrados continuam funcionando.
-- =============================================================

alter table public.products
  add column if not exists success_title        text,
  add column if not exists success_message      text,
  add column if not exists success_button_label text,
  add column if not exists success_button_url   text;

-- Limites conferidos também na aplicação; aqui é a última linha de defesa
-- contra um texto gigante travar a tela do comprador.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_success_len'
  ) then
    alter table public.products add constraint products_success_len check (
      coalesce(length(success_title), 0)        <= 80  and
      coalesce(length(success_message), 0)      <= 600 and
      coalesce(length(success_button_label), 0) <= 40  and
      coalesce(length(success_button_url), 0)   <= 500
    );
  end if;
end $$;

-- O botão só aceita https. javascript: e data: viram XSS na tela de
-- confirmação; http em texto claro vaza o destino da compra.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_success_url_https'
  ) then
    alter table public.products add constraint products_success_url_https check (
      success_button_url is null
      or success_button_url = ''
      or success_button_url ~ '^https://'
    );
  end if;
end $$;
