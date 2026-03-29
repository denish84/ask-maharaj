-- Run once in Supabase → SQL Editor.
-- Seed data: copy data/daily-quotes.example.json → data/daily-quotes.json, then npm run import-daily-quotes
-- api/daily.js reads only this table (no chunks fallback).

create table if not exists public.daily_quotes (
  id uuid primary key default gen_random_uuid(),
  sort_order integer not null,
  quote_text text not null,
  quote_text_gu text,
  theme_title text,
  theme_title_gu text,
  citation text,
  vachanamrut_number text,
  page_start integer,
  created_at timestamptz not null default now(),
  constraint daily_quotes_sort_order_key unique (sort_order)
);

create index if not exists daily_quotes_sort_order_idx on public.daily_quotes (sort_order);

comment on table public.daily_quotes is 'Manual daily card quotes; sort_order 0..n-1 for stable rotation by date.';

alter table public.daily_quotes enable row level security;
