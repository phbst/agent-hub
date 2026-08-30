-- Human-in-the-loop: a worker can pause a task on a question that needs the operator's decision.
-- The task enters waiting_input (slot freed, timeout recovery paused); an answer moves it back to
-- assigned for the same agent, which resumes in the same workspace with the Q&A history.

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in (
  'pending', 'assigned', 'claimed', 'running', 'waiting_input', 'done', 'failed', 'timeout', 'cancelled'
));

create table public.task_interactions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  question text not null check (char_length(question) between 1 and 4000),
  context text,
  options text,
  answer text,
  answered_via text check (answered_via in ('web', 'wechat', 'api')),
  asked_at timestamptz not null default now(),
  answered_at timestamptz
);

create index task_interactions_task_idx on public.task_interactions (task_id, asked_at);
create index task_interactions_open_idx on public.task_interactions (task_id) where answer is null;

create or replace function public.enforce_task_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transition_allowed boolean := false;
  immutable_new jsonb;
  immutable_old jsonb;
begin
  if new.status = old.status then
    transition_allowed := true;
  else
    transition_allowed := case old.status
      when 'pending' then new.status in ('assigned', 'cancelled')
      when 'assigned' then new.status in ('claimed', 'cancelled', 'pending')
      when 'claimed' then new.status in ('running', 'failed', 'timeout', 'cancelled', 'pending')
      when 'running' then new.status in ('waiting_input', 'done', 'failed', 'timeout', 'cancelled', 'pending')
      when 'waiting_input' then new.status in ('assigned', 'cancelled', 'failed')
      when 'timeout' then new.status in ('pending', 'failed')
      else false
    end;
  end if;
  if not transition_allowed then
    raise exception 'illegal task transition: % -> %', old.status, new.status;
  end if;

  if auth.uid() is not null and not public.is_hub_admin() and public.current_agent_id() is not null
     and coalesce(current_setting('agent_hub.internal', true), '') <> 'on' then
    immutable_new := to_jsonb(new) - array['status', 'progress', 'result', 'claimed_at', 'finished_at'];
    immutable_old := to_jsonb(old) - array['status', 'progress', 'result', 'claimed_at', 'finished_at'];
    if immutable_new is distinct from immutable_old then
      raise exception 'agent attempted to update protected task fields';
    end if;
  end if;

  if new.status = 'claimed' and old.status <> 'claimed' then
    new.claimed_at := coalesce(new.claimed_at, now());
  end if;
  if new.status in ('done', 'failed', 'cancelled') and old.status <> new.status then
    new.finished_at := coalesce(new.finished_at, now());
  end if;
  return new;
end
$$;

create or replace function public.log_interaction_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.events(task_id, agent_id, kind, payload)
    values (new.task_id, new.agent_id, 'task.question',
      jsonb_build_object('interaction_id', new.id, 'question', new.question, 'options', new.options, 'context', new.context));
  elsif new.answer is not null and old.answer is null then
    insert into public.events(task_id, agent_id, kind, payload)
    values (new.task_id, new.agent_id, 'task.answered',
      jsonb_build_object('interaction_id', new.id, 'answer', new.answer, 'via', new.answered_via));
  end if;
  return new;
end
$$;

create trigger log_interaction_event_after_change
after insert or update on public.task_interactions
for each row execute function public.log_interaction_event();

-- Operator (admin or a trusted channel via service role) answers the open question and resumes the task.
create or replace function public.answer_task(p_task_id uuid, p_answer text, p_via text default 'web')
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  interaction public.task_interactions%rowtype;
  updated public.tasks%rowtype;
begin
  if auth.uid() is not null and not public.is_hub_admin() then
    raise exception 'only the administrator can answer task questions';
  end if;
  if p_answer is null or char_length(btrim(p_answer)) = 0 then
    raise exception 'answer must not be empty';
  end if;
  if p_via not in ('web', 'wechat', 'api') then
    raise exception 'invalid answer channel: %', p_via;
  end if;

  perform set_config('agent_hub.internal', 'on', true);

  select * into interaction
  from public.task_interactions
  where task_id = p_task_id and answer is null
  order by asked_at desc
  limit 1
  for update;
  if interaction.id is null then raise exception 'task has no open question'; end if;

  update public.task_interactions
  set answer = btrim(p_answer), answered_via = p_via, answered_at = now()
  where id = interaction.id;

  update public.tasks
  set status = 'assigned', progress = 'Answer received, resuming'
  where id = p_task_id and status = 'waiting_input'
  returning * into updated;
  if updated.id is null then raise exception 'task is not waiting for input'; end if;
  return updated;
end
$$;

grant select, insert on public.task_interactions to authenticated;
grant select, insert, update, delete on public.task_interactions to service_role;
revoke execute on function public.log_interaction_event(), public.answer_task(uuid, text, text) from public, anon, authenticated;
grant execute on function public.answer_task(uuid, text, text) to authenticated, service_role;

alter table public.task_interactions enable row level security;
create policy admin_interactions_all on public.task_interactions for all to authenticated
  using (public.is_hub_admin()) with check (public.is_hub_admin());
create policy agent_interactions_select on public.task_interactions for select to authenticated
  using (agent_id = public.current_agent_id());
create policy agent_interactions_insert on public.task_interactions for insert to authenticated
  with check (
    agent_id = public.current_agent_id()
    and exists (select 1 from public.tasks where id = task_id and assigned_to = public.current_agent_id())
  );

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_interactions') then
    alter publication supabase_realtime add table public.task_interactions;
  end if;
end
$$;
