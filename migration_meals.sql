-- 遷移：把「隔幾天」的冷卻改成「隔幾餐」的餐格模型
-- 對象：已經有資料、之前跑過舊 schema.sql 的既有 Supabase 專案。
-- 用法：到 SQL Editor 貼上整份、執行一次。可重複執行（用了 if exists / if not exists）。
-- 全新專案不要跑這份，直接跑 schema.sql 即可。

begin;

-- 1. 先拿掉舊 view。舊 view 是 select r.*，會 depend on restaurants.cooldown_days，
--    不先 drop 掉，第 3 步要 drop cooldown_days 會被擋。
drop view if exists restaurants_with_status;

-- 2. history_entries 加 meal 欄位。
--    舊資料沒有午/晚餐資訊，預設一律先當 'dinner'，之後可在月曆畫面手動改哪幾筆是午餐。
alter table history_entries
  add column if not exists meal text not null default 'dinner'
  check (meal in ('lunch', 'dinner'));

create index if not exists history_entries_restaurant_idx on history_entries (restaurant_id);
create index if not exists history_entries_date_idx on history_entries (eaten_date);

-- 3. restaurants：cooldown_days → cooldown_meals。
--    舊天數粗略換成餐數（1 天 ≈ 2 餐），只是給個起點，之後用 App 的編輯功能逐間微調。
alter table restaurants add column if not exists cooldown_meals integer not null default 0;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurants' and column_name = 'cooldown_days'
  ) then
    update restaurants set cooldown_meals = cooldown_days * 2;
    alter table restaurants drop column cooldown_days;
  end if;
end $$;

-- 3b. 偏好收斂：改成只用 1~5 的 preference 當唯一排序依據，
--     手動拖曳分層（tier / sort_key）整套拿掉，前端改成依分數自動分組、不能拖。
alter table restaurants drop column if exists tier;
alter table restaurants drop column if exists sort_key;

-- 4. 重建 view，改吐 last_eaten_slot / last_eaten_meal（is_available 改由前端算）。
create view restaurants_with_status
with (security_invoker = on) as
select
  r.*,
  le.last_eaten_date,
  le.last_eaten_meal,
  le.last_eaten_slot
from restaurants r
left join lateral (
  select
    h.eaten_date as last_eaten_date,
    h.meal as last_eaten_meal,
    (h.eaten_date - date '1970-01-01') * 2 + case when h.meal = 'dinner' then 1 else 0 end as last_eaten_slot
  from history_entries h
  where h.restaurant_id = r.id
  order by (h.eaten_date - date '1970-01-01') * 2 + case when h.meal = 'dinner' then 1 else 0 end desc
  limit 1
) le on true;

-- 5. view 被 drop 過，grant 也一起沒了，要補回來。
--    ⚠️ 注意：table 層的 grant（restaurants / history_entries）之前就下過了，
--    新增「欄位」不需要再 grant（grant 是 table 級，不是 column 級），所以這裡只補 view。
grant select on public.restaurants_with_status to authenticated;

-- 6. security advisor：固定 set_updated_at 的 search_path（避免 search_path 注入警告）。
alter function public.set_updated_at() set search_path = '';

commit;
