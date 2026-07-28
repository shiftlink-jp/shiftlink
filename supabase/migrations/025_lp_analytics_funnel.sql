-- LPアナリティクス拡張: セクション到達率(ファネル)・離脱箇所・申し込み完了(コンバージョン)を計測
alter table lp_analytics_events add column if not exists section text;
alter table lp_analytics_events add column if not exists max_section text;

alter table lp_analytics_events drop constraint if exists lp_analytics_events_event_type_check;
alter table lp_analytics_events add constraint lp_analytics_events_event_type_check
  check (event_type in ('pageview', 'cta_click', 'dwell', 'section_view', 'conversion'));
