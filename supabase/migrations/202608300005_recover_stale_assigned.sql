-- Gap fix: tasks stuck in `assigned` because the chosen agent's heartbeat went stale were never
-- recovered (recovery only handled claimed/running). Return them to pending so the dispatcher can
-- re-assign; retry_count is untouched because the task never actually started executing.

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

  -- Assigned but never claimed, and the agent has stopped heartbeating: un-assign after 3 minutes.
  for item in
    select task.* from public.tasks task
    left join public.agents agent on agent.id = task.assigned_to
    where task.status = 'assigned'
      and task.created_at < now() - interval '3 minutes'
      and (agent.id is null or agent.last_heartbeat is null or agent.last_heartbeat < now() - interval '90 seconds'
           or agent.status <> 'online' or agent.paused)
    for update of task skip locked
  loop
    update public.tasks set status = 'pending', assigned_to = null,
      progress = 'Re-queued: assigned agent went offline before claiming' where id = item.id;
    recovered := recovered + 1;
  end loop;

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
