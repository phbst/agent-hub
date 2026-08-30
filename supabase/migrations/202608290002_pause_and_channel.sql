alter table public.agents add column if not exists paused boolean not null default false;

-- Paused agents stay online and keep heartbeating, but the dispatcher skips them.
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
      and not agent.paused
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
