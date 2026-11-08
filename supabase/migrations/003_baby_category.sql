-- 이미 만든 가계부에 '임신·육아' 지출 카테고리를 넣는다. (이미 있으면 건너뛴다)
insert into categories (household_id, type, emoji, name)
select h.id, 'expense', '🍼', '임신·육아'
from households h
where not exists (
  select 1 from categories c
  where c.household_id = h.id and c.type = 'expense' and c.name = '임신·육아'
);
