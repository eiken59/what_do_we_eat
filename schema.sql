-- 要吃什麼 App —— schema（餐格冷卻版）
-- 用法：全新的 Supabase 專案，到 SQL Editor 貼上整份執行一次即可。
-- 既有專案（已經有資料）請改跑 migration_meals.sql，不要重跑這份。

-- ─────────────────────────────────────────────
-- 冷卻模型：一天分兩個 meal slot（午餐、晚餐）。
-- 每筆歷史紀錄換算成一個整數 slot 編號：
--   slot = (eaten_date - DATE '1970-01-01') * 2 + (meal = 'dinner' ? 1 : 0)
-- 「隔幾餐」= 中間跳過的 meal slot 數，存在 restaurants.cooldown_meals。
-- 可不可以吃這一餐由前端算（因為要看現在幾點、算哪一餐、且家人都在 UTC+8），
-- view 只負責吐出跟當下時間無關的 last_eaten_slot。
--   可吃 ⟺ (目前這餐 slot − 上次吃的 slot) − 1 >= cooldown_meals
-- ─────────────────────────────────────────────

-- 餐廳主表
create table restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tags text[],                                    -- 例如 {"日式","消夜"}
  preference smallint check (preference between 1 and 5),
  cooldown_meals integer not null default 0,       -- 隔幾「餐」才會再排進來（0 = 下一餐就能再吃）
  tier integer not null default 0,                 -- 分層清單的「層」，數字越小排越前面
  sort_key double precision not null default 0,    -- 同層內的順序，插入時取相鄰兩者中間值，不用重排整批資料
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 歷史紀錄（append log；月曆畫面可補登過去日期、指定午/晚餐，也可刪除修正）
create table history_entries (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  eaten_date date not null default current_date,
  meal text not null default 'dinner' check (meal in ('lunch', 'dinner')),
  chosen_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- 同一天同一餐通常只吃一間，不強制唯一（保留補記兩筆的彈性）；
-- 但常用查詢是「某餐廳最後一次吃是哪個 slot」，加個 index 加速。
create index history_entries_restaurant_idx on history_entries (restaurant_id);
create index history_entries_date_idx on history_entries (eaten_date);

-- 帶「上次吃在哪個 slot」的視圖。last_eaten_slot 即時從歷史紀錄算，不另外存。
-- 只取「slot 編號最大」的那一筆，這樣 last_eaten_meal 對應到的是真正最後一餐，
-- 不會發生「同一天午餐 slot 比前一天晚餐大」之類的排序錯亂。
create view restaurants_with_status as
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

-- 2026-05-30 起，Supabase 新專案預設「新建的 table 不會自動暴露給 Data API」，
-- 這一層 grant 跟下面的 RLS 是兩層不同的檢查，缺這段的話前端會直接吃 42501 permission denied。
grant select, insert, update, delete on table public.restaurants to authenticated;
grant select, insert, update, delete on table public.history_entries to authenticated;
grant select on public.restaurants_with_status to authenticated;

-- 權限：只要是登入的帳號（也就是你和爸媽），對兩張表都能讀寫
-- 因為使用者就是家裡三個人，不做更細的欄位級權限，先求簡單能動
alter table restaurants enable row level security;
alter table history_entries enable row level security;

create policy "authenticated users full access on restaurants"
  on restaurants for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "authenticated users full access on history_entries"
  on history_entries for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- updated_at 自動更新
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger restaurants_set_updated_at
  before update on restaurants
  for each row execute function set_updated_at();
