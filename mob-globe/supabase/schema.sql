-- DRAFT for the Mob Globe. Use a NEW Supabase project, separate from Mob Score. Review before running.
-- Writes come only from the relay using the service-role key (bypasses RLS). Browsers only read the two aggregate tables.
create table if not exists flow_minute (
  bucket timestamptz not null,           -- start of minute (UTC)
  mint text not null, sym text, venue text,
  region smallint not null,              -- 0 Americas, 1 Europe/MEA, 2 Asia-Pacific, -1 bot/unlocated
  buy_usd numeric not null default 0, sell_usd numeric not null default 0, trades int not null default 0,
  primary key (bucket, mint, venue, region)
);
create index if not exists flow_minute_mint_idx on flow_minute (mint, bucket desc);
create table if not exists big_trades (           -- raw rows only for trades >= ~$5k, keep ~30 days
  id bigserial primary key, ts timestamptz not null default now(), sig text unique,
  mint text, sym text, venue text, side text check (side in ('buy','sell')), usd numeric,
  wallet text, region smallint, bot boolean not null default false
);
create index if not exists big_trades_ts_idx on big_trades (ts desc);
create table if not exists wallet_stats (          -- survives restarts; feeds region guess + bot flag
  wallet text primary key, n int not null default 0, hours_mask int not null default 0,
  ll real[] not null default '{0,0,0}', bot boolean not null default false, updated_at timestamptz not null default now()
);
create table if not exists tracked_wallets (addr text primary key, label text, created_at timestamptz not null default now());
alter table flow_minute enable row level security; alter table big_trades enable row level security;
alter table wallet_stats enable row level security; alter table tracked_wallets enable row level security;
create policy "public read flow" on flow_minute for select using (true);
create policy "public read big trades" on big_trades for select using (true);
-- wallet_stats and tracked_wallets: no policies = no anon access (service role only).
-- TODO: hourly rollup table + scheduled job (pg_cron) to roll flow_minute after 7 days, and delete big_trades older than 30 days.
