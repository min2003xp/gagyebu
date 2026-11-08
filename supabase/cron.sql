-- 5분마다 send-digests 함수를 자동 실행한다.
-- __CRON_SECRET__ 자리에 supabase/secrets.local.txt 의 CRON_SECRET 값을 넣어서 실행한다.
-- (tools/make_cron_sql.py 가 값을 채운 cron.local.sql 을 만들어 준다)

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('send-digests') where exists (select 1 from cron.job where jobname = 'send-digests');

select cron.schedule(
  'send-digests',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://vhxbwcuyjbyzaxsmdbct.supabase.co/functions/v1/send-digests',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
    body    := '{}'::jsonb
  );
  $$
);
