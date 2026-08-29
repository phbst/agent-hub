create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create table public.bootstrap_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  expires_at timestamptz not null,
  uses_remaining integer not null check (uses_remaining between 0 and 100),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-zA-Z][a-zA-Z0-9_-]{1,63}$'),
  labels text[] not null default '{}',
  mode text not null check (mode in ('sdk', 'cli', 'session')),
  status text not null default 'pending_approval' check (status in ('pending_approval', 'online', 'offline', 'revoked')),
  max_concurrency integer not null default 1 check (max_concurrency between 1 and 32),
  running_count integer not null default 0 check (running_count between 0 and 32),
  last_heartbeat timestamptz,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  bootstrap_token_id uuid references public.bootstrap_tokens(id) on delete set null,
  registration_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  prompt text not null check (char_length(prompt) between 1 and 100000),
  source text not null check (source in ('wechat', 'web', 'api')),
  source_msg_id text unique,
  target jsonb not null default '{"type":"auto"}'::jsonb,
  assigned_to uuid references public.agents(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'assigned', 'claimed', 'running', 'done', 'failed', 'timeout', 'cancelled')),
  progress text,
  result text,
  priority integer not null default 0 check (priority between -100 and 100),
  timeout_minutes integer not null default 60 check (timeout_minutes between 1 and 1440),
  retry_count integer not null default 0 check (retry_count between 0 and 2),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  constraint valid_target check (
    target->>'type' = 'auto'
    or (target->>'type' = 'agent' and jsonb_typeof(target->'name') = 'string')
    or (target->>'type' = 'label' and jsonb_typeof(target->'labels') = 'array')
  )
);

create index tasks_dispatch_idx on public.tasks (priority desc, created_at) where status = 'pending';
create index tasks_agent_status_idx on public.tasks (assigned_to, status);

create table public.events (
  id bigint generated always as identity primary key,
  task_id uuid references public.tasks(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index events_created_idx on public.events (created_at desc);
create index events_task_idx on public.events (task_id, created_at desc);

create or replace function public.is_hub_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((auth.jwt()->'app_metadata'->>'role') = 'admin', false)
$$;

create or replace function public.current_agent_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.agents where auth_user_id = auth.uid() and status <> 'revoked' limit 1
$$;

create or replace function public.restrict_agent_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not public.is_hub_admin() and coalesce(current_setting('agent_hub.internal', true), '') <> 'on' then
    if (to_jsonb(new) - array['status', 'running_count', 'last_heartbeat'])
       is distinct from (to_jsonb(old) - array['status', 'running_count', 'last_heartbeat']) then
      raise exception 'agent attempted to update protected registration fields';
    end if;
    if new.status not in ('online', 'offline') then
      raise exception 'agent cannot set registration status to %', new.status;
    end if;
  end if;
  return new;
end
$$;

create trigger restrict_agent_update_before_update
before update on public.agents
for each row execute function public.restrict_agent_update();

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
      when 'running' then new.status in ('done', 'failed', 'timeout', 'cancelled', 'pending')
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

create trigger enforce_task_transition_before_update
before update on public.tasks
for each row execute function public.enforce_task_transition();

create or replace function public.log_task_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.events(task_id, agent_id, kind, payload)
    values (new.id, new.assigned_to, 'task.created', jsonb_build_object('status', new.status, 'source', new.source));
  elsif new.status is distinct from old.status then
    insert into public.events(task_id, agent_id, kind, payload)
    values (new.id, new.assigned_to, 'task.' || new.status, jsonb_build_object('from', old.status, 'to', new.status, 'progress', new.progress));
  elsif new.progress is distinct from old.progress then
    insert into public.events(task_id, agent_id, kind, payload)
    values (new.id, new.assigned_to, 'task.progress', jsonb_build_object('progress', new.progress));
  end if;
  return new;
end
$$;

create trigger log_task_event_after_change
after insert or update on public.tasks
for each row execute function public.log_task_event();

create or replace function public.recount_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('agent_hub.internal', 'on', true);
  update public.agents
  set running_count = (
    select count(*)::integer from public.tasks
    where assigned_to = p_agent_id and status in ('claimed', 'running')
  )
  where id = p_agent_id;
end
$$;

create or replace function public.consume_bootstrap_token(
  p_token_hash text,
  p_name text,
  p_labels text[],
  p_mode text,
  p_max_concurrency integer
)
returns public.agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  token public.bootstrap_tokens%rowtype;
  agent public.agents%rowtype;
begin
  select existing.* into agent
  from public.agents existing
  join public.bootstrap_tokens bootstrap on bootstrap.id = existing.bootstrap_token_id
  where bootstrap.token_hash = p_token_hash and existing.name = p_name
  limit 1;
  if agent.id is not null then return agent; end if;

  select * into token
  from public.bootstrap_tokens
  where token_hash = p_token_hash and expires_at > now() and uses_remaining > 0
  for update;
  if token.id is null then raise exception 'bootstrap token is invalid, expired, or exhausted'; end if;

  insert into public.agents(name, labels, mode, max_concurrency, bootstrap_token_id)
  values (p_name, coalesce(p_labels, '{}'), p_mode, p_max_concurrency, token.id)
  returning * into agent;
  update public.bootstrap_tokens set uses_remaining = uses_remaining - 1 where id = token.id;
  return agent;
end
$$;

create or replace function public.sync_agent_running_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.assigned_to is not null then perform public.recount_agent(old.assigned_to); end if;
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to then
    perform public.recount_agent(new.assigned_to);
  elsif new.assigned_to is not null then
    perform public.recount_agent(new.assigned_to);
  end if;
  return new;
end
$$;

create trigger sync_agent_running_after_task
after update on public.tasks
for each row when (old.status is distinct from new.status or old.assigned_to is distinct from new.assigned_to)
execute function public.sync_agent_running_count();

create or replace function public.dispatch_pending_tasks(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued public.tasks%rowtype;
  selected_agent uuid;
  dispatched integer := 0;
begin
  perform set_config('agent_hub.internal', 'on', true);
  for queued in
    select * from public.tasks
    where status = 'pending'
    order by priority desc, created_at
    for update skip locked
    limit greatest(1, least(p_limit, 500))
  loop
    selected_agent := null;
    select agent.id into selected_agent
    from public.agents agent
    where agent.status = 'online'
      and agent.last_heartbeat > now() - interval '90 seconds'
      and case queued.target->>'type'
        when 'agent' then agent.name = queued.target->>'name'
        when 'label' then agent.labels @> array(select jsonb_array_elements_text(queued.target->'labels'))
        else true
      end
    order by
      (agent.running_count::numeric / greatest(agent.max_concurrency, 1)) asc,
      case agent.mode when 'sdk' then 0 when 'cli' then 1 else 2 end,
      agent.name
    limit 1;

    if selected_agent is not null then
      update public.tasks set assigned_to = selected_agent, status = 'assigned' where id = queued.id;
      dispatched := dispatched + 1;
    end if;
  end loop;
  return dispatched;
end
$$;

create or replace function public.dispatch_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.dispatch_pending_tasks(25);
  return new;
end
$$;

create trigger dispatch_task_after_insert
after insert on public.tasks
for each statement execute function public.dispatch_after_insert();

create or replace function public.claim_task(p_task_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare claimed public.tasks%rowtype;
begin
  update public.tasks
  set status = 'claimed', claimed_at = now()
  where id = p_task_id and assigned_to = public.current_agent_id() and status = 'assigned'
  returning * into claimed;
  if claimed.id is null then raise exception 'task is not claimable'; end if;
  return claimed;
end
$$;

create or replace function public.agent_heartbeat()
returns public.agents
language plpgsql
security definer
set search_path = ''
as $$
declare updated public.agents%rowtype;
begin
  update public.agents set last_heartbeat = now(), status = 'online'
  where id = public.current_agent_id() and status <> 'revoked'
  returning * into updated;
  if updated.id is null then raise exception 'agent unavailable'; end if;
  perform public.dispatch_pending_tasks(25);
  return updated;
end
$$;

create or replace function public.recover_timed_out_tasks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare item public.tasks%rowtype;
declare recovered integer := 0;
begin
  perform set_config('agent_hub.internal', 'on', true);
  for item in
    select task.* from public.tasks task
    left join public.agents agent on agent.id = task.assigned_to
    where task.status in ('claimed', 'running')
      and coalesce(task.claimed_at, task.created_at) + make_interval(mins => task.timeout_minutes) < now()
      and (agent.last_heartbeat is null or agent.last_heartbeat < now() - interval '90 seconds')
    for update of task skip locked
  loop
    update public.tasks set status = 'timeout', progress = 'Worker heartbeat expired' where id = item.id;
    if item.retry_count < 2 then
      update public.tasks set status = 'pending', assigned_to = null, claimed_at = null, retry_count = item.retry_count + 1 where id = item.id;
    else
      update public.tasks set status = 'failed', result = 'Task exceeded retry limit after worker timeout' where id = item.id;
    end if;
    recovered := recovered + 1;
  end loop;
  perform public.dispatch_pending_tasks(100);
  return recovered;
end
$$;

select cron.schedule('agent-hub-timeout-recovery', '* * * * *', $$select public.recover_timed_out_tasks();$$)
where not exists (select 1 from cron.job where jobname = 'agent-hub-timeout-recovery');

alter table public.bootstrap_tokens enable row level security;
alter table public.agents enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;

revoke all on public.bootstrap_tokens, public.agents, public.tasks, public.events from anon;
grant select, insert, update, delete on public.bootstrap_tokens, public.agents, public.tasks to authenticated;
grant select, insert on public.events to authenticated;
grant usage, select on sequence public.events_id_seq to authenticated;
revoke execute on function public.is_hub_admin(), public.current_agent_id(), public.enforce_task_transition(),
  public.restrict_agent_update(), public.log_task_event(), public.recount_agent(uuid),
  public.consume_bootstrap_token(text, text, text[], text, integer),
  public.sync_agent_running_count(), public.dispatch_pending_tasks(integer), public.dispatch_after_insert(),
  public.claim_task(uuid), public.agent_heartbeat(), public.recover_timed_out_tasks() from public, anon, authenticated;
grant execute on function public.is_hub_admin(), public.current_agent_id(), public.claim_task(uuid), public.agent_heartbeat() to authenticated;
grant execute on function public.dispatch_pending_tasks(integer), public.recover_timed_out_tasks() to service_role;
grant execute on function public.consume_bootstrap_token(text, text, text[], text, integer) to service_role;

create policy admin_bootstrap_all on public.bootstrap_tokens for all to authenticated using (public.is_hub_admin()) with check (public.is_hub_admin());
create policy admin_agents_all on public.agents for all to authenticated using (public.is_hub_admin()) with check (public.is_hub_admin());
create policy agent_select_self on public.agents for select to authenticated using (id = public.current_agent_id());
create policy agent_update_self on public.agents for update to authenticated using (id = public.current_agent_id()) with check (id = public.current_agent_id());
create policy admin_tasks_all on public.tasks for all to authenticated using (public.is_hub_admin()) with check (public.is_hub_admin());
create policy agent_tasks_select on public.tasks for select to authenticated using (assigned_to = public.current_agent_id());
create policy agent_tasks_update on public.tasks for update to authenticated using (assigned_to = public.current_agent_id()) with check (assigned_to = public.current_agent_id());
create policy admin_events_select on public.events for select to authenticated using (public.is_hub_admin());
create policy admin_events_insert on public.events for insert to authenticated with check (public.is_hub_admin());
create policy agent_events_select on public.events for select to authenticated using (agent_id = public.current_agent_id());
create policy agent_events_insert on public.events for insert to authenticated with check (agent_id = public.current_agent_id());

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agents') then
    alter publication supabase_realtime add table public.agents;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
end
$$;
