-- Run in Supabase SQL Editor if you already created `daily_quotes` without Gujarati columns.

alter table public.daily_quotes
  add column if not exists quote_text_gu text;

alter table public.daily_quotes
  add column if not exists theme_title_gu text;
