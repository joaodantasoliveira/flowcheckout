-- =============================================================
--  Migração 003 — múltiplos gateways
--
--  Rode no SQL Editor do Supabase.
--
--  Cada pedido passa a guardar QUAL gateway o processou. Sem isso,
--  trocar o gateway ativo quebraria a conferência dos pedidos antigos:
--  o sistema perguntaria ao gateway novo por uma transação que só
--  existe no antigo, e cobranças pendentes nunca seriam confirmadas.
-- =============================================================

alter table public.orders
  add column if not exists gateway text not null default 'misticpay';

create index if not exists orders_gateway_idx on public.orders (gateway);

-- Pedidos criados antes desta migração vieram todos da MisticPay,
-- que é o default da coluna — nada a corrigir.

-- Gateway ativo. A aplicação grava aqui ao trocar pelo painel;
-- este insert só garante um valor inicial coerente.
insert into public.settings (key, value)
values ('gateway.active', 'misticpay')
on conflict (key) do nothing;

-- -------------------------------------------------------------
--  Renomeia as credenciais da versão de um gateway só.
--
--  Antes:  misticpay.ci          Agora:  gateway.misticpay.ci
--  Sem isto, as credenciais já salvas ficariam órfãs e o painel
--  mostraria a MisticPay como "não configurada".
--
--  Copia-e-apaga em vez de UPDATE: `key` é chave primária, e um
--  UPDATE quebraria se a linha nova já existisse.
-- -------------------------------------------------------------
insert into public.settings (key, value, secret, updated_at, updated_by)
select 'gateway.misticpay.ci', value, secret, updated_at, updated_by
  from public.settings where key = 'misticpay.ci'
on conflict (key) do nothing;

insert into public.settings (key, value, secret, updated_at, updated_by)
select 'gateway.misticpay.cs', value, secret, updated_at, updated_by
  from public.settings where key = 'misticpay.cs'
on conflict (key) do nothing;

delete from public.settings where key in ('misticpay.ci', 'misticpay.cs');
