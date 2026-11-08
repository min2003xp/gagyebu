-- 우리집 가계부: Supabase 데이터베이스 설계도
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run 하면 된다. (여러 번 실행해도 안전)
--
-- 구조: 한 '가구(household)'에 최대 두 명(a, b)이 들어가고,
--       모든 데이터에는 household_id 가 붙어서 같은 가구 사람만 읽고 쓸 수 있다.

create extension if not exists pgcrypto;

-- 가구 ---------------------------------------------------------------
create table if not exists households (
  id          uuid primary key default gen_random_uuid(),
  invite_code text unique not null default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  names       jsonb not null default '{"a":"나","b":"아내"}',
  budgets     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table if not exists members (
  household_id uuid not null references households on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  who          text not null check (who in ('a', 'b')),
  primary key (household_id, user_id),
  unique (household_id, who),
  unique (user_id)
);

-- 로그인한 사람의 가구 id
create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from members where user_id = auth.uid()
$$;

-- 데이터 표 ---------------------------------------------------------
create table if not exists categories (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  type         text not null check (type in ('expense', 'income')),
  emoji        text not null default '🏷️',
  name         text not null,
  created_at   timestamptz not null default now()
);

create table if not exists transactions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default my_household() references households on delete cascade,
  type          text not null check (type in ('expense', 'income')),
  amount        bigint not null check (amount >= 0),
  date          date not null,
  category_id   uuid,
  who           text not null check (who in ('a', 'b')),
  memo          text not null default '',
  recurring_key text,
  created_at    timestamptz not null default now(),
  unique (household_id, recurring_key)  -- 고정 지출이 두 폰에서 중복으로 들어가는 것 방지
);
create index if not exists transactions_date_idx on transactions (household_id, date);

create table if not exists recurring (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  type         text not null check (type in ('expense', 'income')),
  amount       bigint not null check (amount >= 0),
  category_id  uuid,
  who          text not null check (who in ('a', 'b')),
  memo         text not null default '',
  day          int not null check (day between 1 and 31),
  start_month  text not null,
  last_applied text,
  created_at   timestamptz not null default now()
);

create table if not exists assets (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  name         text not null,
  kind         text not null,
  owner        text not null check (owner in ('a', 'b', 'both')),
  balances     jsonb not null default '{}',   -- { "2026-11": 1000000, ... }
  created_at   timestamptz not null default now()
);

create table if not exists activity (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  at           timestamptz not null default now(),
  author       text not null check (author in ('a', 'b')),   -- 누가 바꿨나
  action       text not null check (action in ('add', 'update', 'delete')),
  target       text not null,
  summary      text not null,
  notified_at  timestamptz
);
create index if not exists activity_pending_idx on activity (household_id, author) where notified_at is null;

-- 폰 푸시 알림 받을 주소 (알림 단계에서 사용)
create table if not exists push_subscriptions (
  endpoint     text primary key,
  household_id uuid not null default my_household() references households on delete cascade,
  who          text not null check (who in ('a', 'b')),
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);

-- 보안 규칙: 같은 가구 사람만 ------------------------------------------
alter table households         enable row level security;
alter table members            enable row level security;
alter table categories         enable row level security;
alter table transactions       enable row level security;
alter table recurring          enable row level security;
alter table assets             enable row level security;
alter table activity           enable row level security;
alter table push_subscriptions enable row level security;

drop policy if exists "내 가구 보기" on households;
drop policy if exists "내 가구 수정" on households;
create policy "내 가구 보기" on households for select using (id = my_household());
create policy "내 가구 수정" on households for update using (id = my_household()) with check (id = my_household());

drop policy if exists "내 가구 멤버 보기" on members;
create policy "내 가구 멤버 보기" on members for select using (household_id = my_household());

do $$
declare t text;
begin
  foreach t in array array['categories', 'transactions', 'recurring', 'assets', 'activity', 'push_subscriptions'] loop
    execute format('drop policy if exists "우리 가구만" on %I', t);
    execute format('create policy "우리 가구만" on %I for all using (household_id = my_household()) with check (household_id = my_household())', t);
  end loop;
end $$;

-- 가구 만들기 / 초대 코드로 들어가기 ------------------------------------
create or replace function create_household() returns text
language plpgsql security definer set search_path = public as $$
declare hid uuid; code text;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    select invite_code into code from households where id = my_household();
    return code;
  end if;

  insert into households default values returning id, invite_code into hid, code;
  insert into members (household_id, user_id, who) values (hid, auth.uid(), 'a');

  insert into categories (household_id, type, emoji, name)
  select hid, c.type, c.emoji, c.name from (values
    ('expense', '🍚', '식비'), ('expense', '☕', '카페·간식'), ('expense', '🧻', '생활용품'),
    ('expense', '🚌', '교통'), ('expense', '🏠', '주거·관리비'), ('expense', '📱', '통신'),
    ('expense', '💊', '의료'), ('expense', '🍼', '임신·육아'), ('expense', '👕', '쇼핑'), ('expense', '🎬', '문화·여가'),
    ('expense', '🎁', '경조사·선물'), ('expense', '📦', '기타'),
    ('income', '💰', '월급'), ('income', '💵', '부수입'), ('income', '🪙', '기타 수입')
  ) as c(type, emoji, name);

  return code;
end $$;

create or replace function join_household(code text) returns void
language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then raise exception '이미 가계부에 들어가 있어요'; end if;
  select id into hid from households where invite_code = upper(trim(code));
  if hid is null then raise exception '초대 코드가 맞지 않아요'; end if;
  if exists (select 1 from members where household_id = hid and who = 'b') then raise exception '이미 두 명이 쓰고 있는 가계부예요'; end if;
  insert into members (household_id, user_id, who) values (hid, auth.uid(), 'b');
end $$;

revoke all on function create_household() from public, anon;
revoke all on function join_household(text) from public, anon;
grant execute on function create_household() to authenticated;
grant execute on function join_household(text) to authenticated;

-- 실시간 동기화: 한 폰에서 바꾸면 다른 폰에 바로 반영 -------------------
do $$
declare t text;
begin
  foreach t in array array['households', 'categories', 'transactions', 'recurring', 'assets', 'activity'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
