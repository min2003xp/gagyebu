-- 002: 결제수단(카드·상품권), 충전, 통계 제외
-- Supabase > SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전.

-- 결제수단: kind = 'card'(일반 카드·현금) | 'prepaid'(충전해서 쓰는 상품권·선불카드)
create table if not exists payment_methods (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default my_household() references households on delete cascade,
  name            text not null,
  kind            text not null default 'card' check (kind in ('card', 'prepaid')),
  initial_balance bigint not null default 0,   -- 충전식: 등록할 때 이미 남아 있던 잔액
  created_at      timestamptz not null default now()
);

alter table payment_methods enable row level security;
drop policy if exists "우리 가구만" on payment_methods;
create policy "우리 가구만" on payment_methods for all
  using (household_id = my_household()) with check (household_id = my_household());

-- 내역에 결제수단 / 통계 제외 / 충전 때 실제 낸 돈
alter table transactions add column if not exists payment_id  uuid;
alter table transactions add column if not exists excluded    boolean not null default false;
alter table transactions add column if not exists paid_amount bigint;

-- 내역 종류에 '충전(charge)' 추가
alter table transactions drop constraint if exists transactions_type_check;
alter table transactions add constraint transactions_type_check check (type in ('expense', 'income', 'charge'));

-- 고정 지출에도 결제수단
alter table recurring add column if not exists payment_id uuid;

-- 실시간 동기화
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'payment_methods') then
    alter publication supabase_realtime add table payment_methods;
  end if;
end $$;
