-- Job Book: database setup. Run once in the Supabase SQL Editor (already done 2026-10-26).
-- Safe to re-run: every statement checks for what already exists.
-- Creates new jobbook_ tables only. Field Measure is not touched.

create table if not exists public.jobbook_members (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

create schema if not exists jobbook_private;

create or replace function jobbook_private.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.jobbook_members m where m.user_id = (select auth.uid()));
$$;
revoke all on function jobbook_private.is_member() from public, anon;
grant usage on schema jobbook_private to authenticated, service_role;
grant execute on function jobbook_private.is_member() to authenticated, service_role;

create table if not exists public.jobbook_books (
  id text primary key, data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create table if not exists public.jobbook_jobs (
  id text primary key, data jsonb not null default '{}'::jsonb,
  book_id text generated always as (data->>'bookId') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists jobbook_jobs_book_id on public.jobbook_jobs (book_id);
create table if not exists public.jobbook_notes (
  id text primary key, data jsonb not null default '{}'::jsonb,
  job_id text generated always as (data->>'jobId') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists jobbook_notes_job_id on public.jobbook_notes (job_id);
create table if not exists public.jobbook_people (
  id text primary key, data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create or replace function jobbook_private.touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end;
$$;
create or replace trigger jobbook_books_touch  before update on public.jobbook_books  for each row execute function jobbook_private.touch();
create or replace trigger jobbook_jobs_touch   before update on public.jobbook_jobs   for each row execute function jobbook_private.touch();
create or replace trigger jobbook_notes_touch  before update on public.jobbook_notes  for each row execute function jobbook_private.touch();
create or replace trigger jobbook_people_touch before update on public.jobbook_people for each row execute function jobbook_private.touch();

create or replace function public.jobbook_patch(p_collection text, p_id text, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if p_collection not in ('books', 'jobs', 'notes', 'people') then
    raise exception 'unknown collection %', p_collection;
  end if;
  execute format('update public.%I set data = data || $1 where id = $2 returning data', 'jobbook_' || p_collection)
    into result using p_patch, p_id;
  if result is null then
    raise exception 'record % not found in %', p_id, p_collection using errcode = 'P0002';
  end if;
  return result;
end;
$$;
revoke all on function public.jobbook_patch(text, text, jsonb) from public, anon;
grant execute on function public.jobbook_patch(text, text, jsonb) to authenticated, service_role;

grant select on public.jobbook_members to authenticated;
grant select, insert, update, delete on public.jobbook_books, public.jobbook_jobs, public.jobbook_notes, public.jobbook_people to authenticated;
grant all on public.jobbook_members, public.jobbook_books, public.jobbook_jobs, public.jobbook_notes, public.jobbook_people to service_role;

alter table public.jobbook_members enable row level security;
alter table public.jobbook_books   enable row level security;
alter table public.jobbook_jobs    enable row level security;
alter table public.jobbook_notes   enable row level security;
alter table public.jobbook_people  enable row level security;

do $$
declare t text;
begin
  if not exists (select 1 from pg_policies where tablename = 'jobbook_members' and policyname = 'see own membership') then
    create policy "see own membership" on public.jobbook_members for select to authenticated using (user_id = (select auth.uid()));
  end if;
  foreach t in array array['jobbook_books', 'jobbook_jobs', 'jobbook_notes', 'jobbook_people'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'members read') then
      execute format('create policy "members read" on public.%I for select to authenticated using ((select jobbook_private.is_member()))', t);
      execute format('create policy "members add" on public.%I for insert to authenticated with check ((select jobbook_private.is_member()))', t);
      execute format('create policy "members change" on public.%I for update to authenticated using ((select jobbook_private.is_member())) with check ((select jobbook_private.is_member()))', t);
      execute format('create policy "members remove" on public.%I for delete to authenticated using ((select jobbook_private.is_member()))', t);
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Who may use Job Book. Nobody is on the list until added here. To add someone,
-- have them create an account in the app first, then run (with their email):
--   insert into public.jobbook_members (user_id)
--     select id from auth.users where email = 'their@email.com'
--     on conflict do nothing;

-- Signed-out visitors get no table access at all; signed-in users get only
-- the four everyday actions. (Applied as a second step on 2026-10-26.)
revoke all on public.jobbook_members, public.jobbook_books, public.jobbook_jobs,
  public.jobbook_notes, public.jobbook_people from anon;
revoke truncate, references, trigger on public.jobbook_books, public.jobbook_jobs,
  public.jobbook_notes, public.jobbook_people from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.jobbook_members from authenticated;

select 'Job Book setup done' as result,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'jobbook_%') as tables_created,
  (select count(*) from public.jobbook_members) as members;
