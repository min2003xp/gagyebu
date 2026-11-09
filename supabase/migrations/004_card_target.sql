-- 카드마다 '한 달 실적 목표' 금액을 저장한다. (0 = 목표 없음)
alter table payment_methods add column if not exists target bigint not null default 0;
