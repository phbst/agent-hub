-- File transfer: operators attach input files to a task; workers deliver output files back.
-- Storage layout in the private task-files bucket: <task_id>/in/<name> and <task_id>/out/<name>.

create table public.task_files (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  direction text not null check (direction in ('in', 'out', 'log')),
  name text not null check (char_length(name) between 1 and 255),
  path text not null unique,
  size bigint check (size is null or size >= 0),
  mime text,
  created_at timestamptz not null default now()
);

create index task_files_task_idx on public.task_files (task_id, direction, created_at);

create or replace function public.log_file_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.direction = 'out' then
    insert into public.events(task_id, agent_id, kind, payload)
    values (new.task_id, new.agent_id, 'task.file',
      jsonb_build_object('file_id', new.id, 'name', new.name, 'path', new.path, 'size', new.size));
  end if;
  return new;
end
$$;

create trigger log_file_event_after_insert
after insert on public.task_files
for each row execute function public.log_file_event();

grant select, insert on public.task_files to authenticated;
grant select, insert, update, delete on public.task_files to service_role;
revoke execute on function public.log_file_event() from public, anon, authenticated;

alter table public.task_files enable row level security;
create policy admin_task_files_all on public.task_files for all to authenticated
  using (public.is_hub_admin()) with check (public.is_hub_admin());
create policy agent_task_files_select on public.task_files for select to authenticated
  using (exists (select 1 from public.tasks where id = task_id and assigned_to = public.current_agent_id()));
create policy agent_task_files_insert on public.task_files for insert to authenticated
  with check (
    direction in ('out', 'log')
    and agent_id = public.current_agent_id()
    and exists (select 1 from public.tasks where id = task_id and assigned_to = public.current_agent_id())
  );

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-files', 'task-files', false, 104857600)
on conflict (id) do nothing;

create policy task_files_read on storage.objects for select to authenticated
  using (
    bucket_id = 'task-files'
    and (
      public.is_hub_admin()
      or exists (
        select 1 from public.tasks t
        where t.id::text = (storage.foldername(name))[1] and t.assigned_to = public.current_agent_id()
      )
    )
  );

create policy task_files_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'task-files' and public.is_hub_admin());

create policy task_files_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'task-files' and public.is_hub_admin());

create policy task_files_agent_write on storage.objects for insert to authenticated
  with check (
    bucket_id = 'task-files'
    and (storage.foldername(name))[2] in ('out', 'log')
    and exists (
      select 1 from public.tasks t
      where t.id::text = (storage.foldername(name))[1] and t.assigned_to = public.current_agent_id()
    )
  );
