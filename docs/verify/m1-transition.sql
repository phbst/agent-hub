begin;
insert into public.tasks(title, prompt, source, target)
values ('M1 transition smoke', 'Return the word ok', 'api', '{"type":"auto"}')
returning id, status;
select public.dispatch_pending_tasks(10);
select id, status, assigned_to from public.tasks where title = 'M1 transition smoke';
rollback;
