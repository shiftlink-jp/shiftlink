-- LPアナリティクス用テーブル（GA4とは別に自前で軽量計測する）
create table if not exists lp_analytics_events (
  id bigserial primary key,
  event_type text not null check (event_type in ('pageview', 'cta_click', 'dwell')),
  session_id text not null,
  path text,
  cta_text text,
  dwell_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_lp_analytics_events_created_at on lp_analytics_events (created_at);
create index if not exists idx_lp_analytics_events_session_id on lp_analytics_events (session_id);

alter table lp_analytics_events enable row level security;

-- LPの匿名訪問者からのINSERTのみ許可（閲覧・更新・削除は不可。集計はservice_role経由のEdge Functionのみ）
create policy "lp_analytics_events anon insert only"
  on lp_analytics_events for insert
  to anon
  with check (true);
