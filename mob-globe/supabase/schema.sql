-- Mob Globe schema. Use a NEW Supabase project, separate from Mob Score. Safe to re-run.
-- Only the relay writes/reads, using the service-role key (bypasses RLS). RLS is ON with no policies,
-- so the anon/public key can read nothing. The browser gets charts through the relay's /api/flow.

create table if not exists flow_minute (
  bucket timestamptz not null,           -- start of minute (UTC)
  mint text not null, sym text,
  venue text not null default '',
  region smallint not null,              -- 0 Americas, 1 Europe/MEA, 2 Asia-Pacific, -1 bot/unlocated (estimates)
  buy_usd numeric not null default 0, sell_usd numeric not null default 0, trades int not null default 0,
  primary key (bucket, mint, venue, region)
);
create index if not exists flow_minute_bucket_idx on flow_minute (bucket);
create index if not exists flow_minute_mint_idx on flow_minute (mint, bucket desc);

create table if not exists hourly_flow (  -- rollup of flow_minute older than 7 days (venue dropped)
  bucket timestamptz not null, mint text not null, sym text, region smallint not null,
  buy_usd numeric not null default 0, sell_usd numeric not null default 0, trades int not null default 0,
  primary key (bucket, mint, region)
);

create table if not exists big_trades (    -- raw rows only for trades >= ~$5k, kept 30 days
  id bigserial primary key, ts timestamptz not null default now(), sig text unique,
  mint text, sym text, venue text, side text check (side in ('buy','sell')), usd numeric,
  wallet text, region smallint, bot boolean not null default false
);
create index if not exists big_trades_ts_idx on big_trades (ts desc);

create table if not exists wallet_stats (  -- survives restarts; feeds the region estimate + bot flag
  wallet text primary key, n int not null default 0, hours_mask int not null default 0,
  ll real[] not null default '{0,0,0}', bot boolean not null default false, updated_at timestamptz not null default now()
);
create index if not exists wallet_stats_updated_idx on wallet_stats (updated_at desc);

create table if not exists tracked_wallets (addr text primary key, label text, created_at timestamptz not null default now());

alter table flow_minute enable row level security;
alter table hourly_flow enable row level security;
alter table big_trades enable row level security;
alter table wallet_stats enable row level security;
alter table tracked_wallets enable row level security;

-- Totals per bucket for the charts. unit = 'hour' or 'day'. Reads recent minutes + older hourly rollups.
create or replace function flow_agg(since timestamptz, unit text default 'hour')
returns table(t timestamptz, buy numeric, sell numeric, trades bigint)
language sql stable as $$
  select date_trunc(case when unit = 'day' then 'day' else 'hour' end, x.b), sum(x.bu), sum(x.se), sum(x.tr)::bigint
  from (
    select bucket b, buy_usd bu, sell_usd se, trades::bigint tr from flow_minute where bucket >= since
    union all
    select bucket, buy_usd, sell_usd, trades::bigint from hourly_flow
      where bucket >= since and bucket < coalesce((select min(bucket) from flow_minute), 'infinity'::timestamptz)
  ) x group by 1 order by 1
$$;

-- Top tokens by volume since a date (for the "since launch" leaderboard).
create or replace function flow_top(since timestamptz, n int default 10)
returns table(mint text, sym text, buy numeric, sell numeric, trades bigint)
language sql stable as $$
  select x.mint, max(x.sym), sum(x.bu), sum(x.se), sum(x.tr)::bigint
  from (
    select mint, sym, buy_usd bu, sell_usd se, trades::bigint tr from flow_minute where bucket >= since
    union all
    select mint, sym, buy_usd, sell_usd, trades::bigint from hourly_flow
      where bucket >= since and bucket < coalesce((select min(bucket) from flow_minute), 'infinity'::timestamptz)
  ) x group by x.mint order by sum(x.bu) + sum(x.se) desc limit least(greatest(n, 1), 50)
$$;

-- Roll old minutes into hourly rows and apply retention. Run hourly (see pg_cron below).
create or replace function rollup_hourly(older_than interval default '7 days')
returns void language plpgsql as $$
begin
  insert into hourly_flow (bucket, mint, sym, region, buy_usd, sell_usd, trades)
  select date_trunc('hour', bucket), mint, max(sym), region, sum(buy_usd), sum(sell_usd), sum(trades)
  from flow_minute where bucket < now() - older_than group by 1, 2, 4
  on conflict (bucket, mint, region) do update set
    buy_usd = hourly_flow.buy_usd + excluded.buy_usd, sell_usd = hourly_flow.sell_usd + excluded.sell_usd,
    trades = hourly_flow.trades + excluded.trades, sym = coalesce(excluded.sym, hourly_flow.sym);
  delete from flow_minute where bucket < now() - older_than;
  delete from big_trades where ts < now() - interval '30 days';
end $$;

-- Optional scheduling: enable the pg_cron extension (Dashboard > Database > Extensions), then run:
--   select cron.schedule('mob-rollup', '7 * * * *', $$select rollup_hourly()$$);


-- Paper trading arena leaderboard (fun game, no real money). Safe to re-run.
create table if not exists arena_players (
  id text primary key,
  name text not null,
  equity numeric not null,
  level int not null default 1,
  wins int not null default 0,
  updated_at timestamptz not null default now()
);
alter table arena_players enable row level security;
