-- =============================================================
--  Migração 006 — pixels do Meta e rastreamento de conversão
--
--  Rode no SQL Editor do Supabase.
--
--  Biblioteca de pixels: o mesmo pixel pode servir vários produtos,
--  e um produto novo pode ter o seu. Cada produto aponta para um.
-- =============================================================

create table if not exists public.pixels (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  -- ID numérico do pixel (não é segredo: aparece no HTML da landing).
  pixel_id         text        not null,
  -- Token da Conversions API, cifrado com AES-256-GCM pela aplicação.
  access_token     text,
  -- Código de teste do Events Manager, para validar sem sujar os dados.
  test_event_code  text,
  active           boolean     not null default true,
  last_event_at    timestamptz,
  last_event_status text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint pixels_pixel_id_formato check (pixel_id ~ '^[0-9]{8,20}$'),
  constraint pixels_name_len check (length(name) between 2 and 60)
);

create index if not exists pixels_active_idx on public.pixels (active);

-- Produto escolhe qual pixel usa. ON DELETE SET NULL: apagar o pixel não
-- pode derrubar o produto junto.
alter table public.products
  add column if not exists pixel_id uuid references public.pixels(id) on delete set null;

create index if not exists products_pixel_idx on public.products (pixel_id);

-- -------------------------------------------------------------
--  Identificadores de atribuição no pedido
--
--  Vêm da landing page pela URL (cookie não atravessa domínio) e
--  são reenviados à Conversions API na hora da compra. Sem eles o
--  Event Match Quality despenca.
-- -------------------------------------------------------------
alter table public.orders
  add column if not exists tracking jsonb;

-- Evita reenviar Purchase se o pedido for reprocessado.
alter table public.orders
  add column if not exists purchase_sent_at timestamptz;

alter table public.pixels enable row level security;
revoke all on public.pixels from anon, authenticated;
