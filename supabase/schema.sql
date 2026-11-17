-- Synonym Match cloud progress schema and merge RPC.
-- Run this file in the Supabase SQL Editor as a project administrator.

-- PostgreSQL CHECK constraints cannot contain a subquery, so this immutable
-- helper validates that a JSON array contains strings only.
create or replace function public.jsonb_array_of_strings(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
as $function$
declare
  item jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array' then
    return false;
  end if;

  for item in select jsonb_array_elements(p_value)
  loop
    if jsonb_typeof(item) <> 'string' then
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

create table if not exists public.challenge_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  book_id text not null check (book_id in ('ielts', 'cet6', 'postgrad', 'cet4')),
  scope text not null check (scope in ('frequent', 'full')),
  seed bigint not null check (seed >= 0 and seed <= 9007199254740991),
  completed_pair_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(completed_pair_ids) = 'array')
    check (public.jsonb_array_of_strings(completed_pair_ids)),
  score integer not null default 0 check (score >= 0),
  correct_matches integer not null default 0 check (correct_matches >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (correct_matches <= attempts)
);

create or replace function public.challenge_progress_set_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists challenge_progress_set_updated_at on public.challenge_progress;
create trigger challenge_progress_set_updated_at
before update on public.challenge_progress
for each row
execute function public.challenge_progress_set_updated_at();

alter table public.challenge_progress enable row level security;

drop policy if exists challenge_progress_select_own on public.challenge_progress;
create policy challenge_progress_select_own
on public.challenge_progress
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists challenge_progress_insert_own on public.challenge_progress;
create policy challenge_progress_insert_own
on public.challenge_progress
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists challenge_progress_update_own on public.challenge_progress;
create policy challenge_progress_update_own
on public.challenge_progress
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists challenge_progress_delete_own on public.challenge_progress;
create policy challenge_progress_delete_own
on public.challenge_progress
for delete
to authenticated
using (auth.uid() = user_id);

revoke all on table public.challenge_progress from public;
revoke all on table public.challenge_progress from anon;
revoke all on table public.challenge_progress from authenticated;
grant select, insert, update, delete on table public.challenge_progress to authenticated;

create or replace function public.merge_challenge_progress(
  p_book_id text,
  p_scope text,
  p_seed bigint,
  p_completed_pair_ids jsonb,
  p_score integer,
  p_correct_matches integer,
  p_attempts integer,
  p_client_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_record jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  insert into public.challenge_progress as cp (
    user_id,
    book_id,
    scope,
    seed,
    completed_pair_ids,
    score,
    correct_matches,
    attempts,
    client_updated_at
  )
  values (
    v_user_id,
    p_book_id,
    p_scope,
    p_seed,
    p_completed_pair_ids,
    p_score,
    p_correct_matches,
    p_attempts,
    p_client_updated_at
  )
  on conflict (user_id) do update
  set
    completed_pair_ids = (
      select coalesce(
        jsonb_agg(to_jsonb(pair_id) order by pair_id),
        '[]'::jsonb
      )
      from (
        select distinct pair_id
        from jsonb_array_elements_text(
          cp.completed_pair_ids || excluded.completed_pair_ids
        ) as expanded(pair_id)
      ) as merged_pairs
    ),
    seed = case
      when excluded.client_updated_at >= cp.client_updated_at
        then excluded.seed
      else cp.seed
    end,
    score = case
      when excluded.client_updated_at >= cp.client_updated_at
        then excluded.score
      else cp.score
    end,
    correct_matches = case
      when excluded.client_updated_at >= cp.client_updated_at
        then excluded.correct_matches
      else cp.correct_matches
    end,
    attempts = case
      when excluded.client_updated_at >= cp.client_updated_at
        then excluded.attempts
      else cp.attempts
    end,
    client_updated_at = case
      when excluded.client_updated_at >= cp.client_updated_at
        then excluded.client_updated_at
      else cp.client_updated_at
    end
  where cp.book_id = p_book_id
    and cp.scope = p_scope
  returning to_jsonb(cp) into v_record;

  if found then
    return jsonb_build_object('status', 'merged', 'record', v_record);
  end if;

  -- A different book/scope for this user is a guarded conflict. The select
  -- observes the row and leaves it unchanged.
  select to_jsonb(existing_row)
    into v_record
    from public.challenge_progress as existing_row
   where existing_row.user_id = v_user_id;

  return jsonb_build_object(
    'status', 'conflict',
    'record', coalesce(v_record, '{}'::jsonb)
  );
end;
$function$;

revoke all on function public.merge_challenge_progress(
  text, text, bigint, jsonb, integer, integer, integer, timestamptz
) from public;
revoke all on function public.merge_challenge_progress(
  text, text, bigint, jsonb, integer, integer, integer, timestamptz
) from anon;
grant execute on function public.merge_challenge_progress(
  text, text, bigint, jsonb, integer, integer, integer, timestamptz
) to authenticated;
