import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  TIERS,
  MEALS,
  MEAL_ORDER,
  MEAL_CUTOFF_HOUR,
} from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- DOM ----------
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const nowSlotLabel = document.getElementById('now-slot-label');
const mealToggle = document.getElementById('meal-toggle');
const nowListEl = document.getElementById('now-list');
const nowEmptyEl = document.getElementById('now-empty');
const coolingWrap = document.getElementById('cooling-wrap');
const coolingListEl = document.getElementById('cooling-list');
const coolingCountEl = document.getElementById('cooling-count');

const tierListEl = document.getElementById('tier-list');
const addForm = document.getElementById('add-form');

const editModal = document.getElementById('edit-modal');
const editNameEl = document.getElementById('edit-name');
const editTagsEl = document.getElementById('edit-tags');
const editPrefEl = document.getElementById('edit-preference');
const editCooldownEl = document.getElementById('edit-cooldown');
const editErrorEl = document.getElementById('edit-error');
const editSaveBtn = document.getElementById('edit-save');
const editDeleteBtn = document.getElementById('edit-delete');
const editCancelBtn = document.getElementById('edit-cancel');

const calPrevBtn = document.getElementById('cal-prev');
const calNextBtn = document.getElementById('cal-next');
const calTitleEl = document.getElementById('cal-title');
const calendarEl = document.getElementById('calendar');
const dayModal = document.getElementById('day-modal');
const dayTitleEl = document.getElementById('day-title');
const daySlotsEl = document.getElementById('day-slots');
const dayCloseBtn = document.getElementById('day-close');

const toastEl = document.getElementById('toast');

// ---------- 狀態 ----------
let currentUserId = null;
let sortableInstances = [];
let allRestaurants = []; // restaurants_with_status 的 rows（含 last_eaten_slot）
let manualMeal = null; // null = 用時間自動判斷；否則 'lunch' / 'dinner'
let editingId = null;
const _today = new Date();
let calYear = _today.getFullYear();
let calMonth = _today.getMonth(); // 0-based
let calEntries = []; // 目前月份的 history_entries

// ---------- 餐格（meal slot）計算 ----------
// slot = 距離 1970-01-01 的天數 * 2 + (晚餐 ? 1 : 0)，跟 SQL view 的算法一致。
function dayIndex(y, m, d) {
  // 用當地民曆日期組出「距離 1970-01-01 的天數」，不受時區/DST 影響
  return Math.floor(Date.UTC(y, m, d) / 86400000);
}
function slotOf(y, m, d, meal) {
  return dayIndex(y, m, d) * 2 + (meal === 'dinner' ? 1 : 0);
}
function autoMeal(date) {
  return date.getHours() < MEAL_CUTOFF_HOUR ? 'lunch' : 'dinner';
}
function currentMeal() {
  return manualMeal || autoMeal(new Date());
}
function currentSlot() {
  const d = new Date();
  return slotOf(d.getFullYear(), d.getMonth(), d.getDate(), currentMeal());
}

// 可吃 ⟺ (目前這餐 slot − 上次吃的 slot) − 1 >= cooldown_meals
// last_eaten_slot 為 null（沒吃過）時永遠可吃。
function isAvailable(r, slot) {
  if (r.last_eaten_slot === null || r.last_eaten_slot === undefined) return true;
  return slot - r.last_eaten_slot - 1 >= (r.cooldown_meals || 0);
}
// 還要幾餐才會解鎖（>0 才顯示）
function mealsUntilAvailable(r, slot) {
  if (r.last_eaten_slot === null || r.last_eaten_slot === undefined) return 0;
  return (r.cooldown_meals || 0) + 1 - (slot - r.last_eaten_slot);
}

// ---------- 登入狀態 ----------
async function checkSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) {
    currentUserId = session.user.id;
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  loadRestaurants();
  loadCalendar();
  subscribeRealtime();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    loginError.textContent = '登入失敗：' + error.message;
    return;
  }
  currentUserId = data.user.id;
  showApp();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  showLogin();
});

// ---------- 分頁切換 ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + '-panel').classList.remove('hidden');
    if (btn.dataset.tab === 'now') renderNow();
    if (btn.dataset.tab === 'cal') renderCalendar();
  });
});

// ---------- 讀餐廳資料 ----------
async function loadRestaurants() {
  const { data, error } = await supabase
    .from('restaurants_with_status')
    .select('*')
    .order('tier', { ascending: true })
    .order('sort_key', { ascending: true });

  if (error) {
    console.error(error);
    return;
  }
  allRestaurants = data || [];
  renderNow();
  renderTiers(allRestaurants);
}

// ---------- 現在吃什麼（輸出畫面） ----------
function renderNow() {
  const meal = currentMeal();
  const slot = currentSlot();

  // 更新標題與午/晚餐切換的 active 狀態
  const d = new Date();
  nowSlotLabel.textContent = `現在幫你決定：${d.getMonth() + 1}/${d.getDate()} ${MEALS[meal]}`;
  mealToggle.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.meal === meal);
  });

  const sorted = [...allRestaurants].sort(
    (a, b) => a.tier - b.tier || a.sort_key - b.sort_key
  );
  const available = sorted.filter((r) => isAvailable(r, slot));
  const cooling = sorted.filter((r) => !isAvailable(r, slot));

  // 可吃清單
  nowListEl.innerHTML = '';
  available.forEach((r) => nowListEl.appendChild(renderNowItem(r, meal)));
  nowEmptyEl.classList.toggle('hidden', available.length > 0 || allRestaurants.length === 0);

  // 冷卻中清單
  coolingCountEl.textContent = cooling.length;
  coolingWrap.classList.toggle('hidden', cooling.length === 0);
  coolingListEl.innerHTML = '';
  cooling.forEach((r) => coolingListEl.appendChild(renderCoolingItem(r, slot)));
}

function renderNowItem(r, meal) {
  const li = document.createElement('li');
  li.className = 'restaurant-item';
  li.innerHTML = `
    <span class="tier-dot tier-${r.tier}"></span>
    <span class="restaurant-name">${escapeHtml(r.name)}</span>
    <span class="restaurant-pref">${'★'.repeat(r.preference || 0)}</span>
    <button class="eat-btn" type="button">吃這間</button>
  `;
  li.querySelector('.eat-btn').addEventListener('click', () => {
    const d = new Date();
    markEaten(r.id, r.name, localDateStr(d), meal);
  });
  return li;
}

function renderCoolingItem(r, slot) {
  const li = document.createElement('li');
  li.className = 'restaurant-item';
  const left = mealsUntilAvailable(r, slot);
  const lastLabel = r.last_eaten_date
    ? `上次 ${shortDate(r.last_eaten_date)} ${MEALS[r.last_eaten_meal] || ''}`
    : '';
  li.innerHTML = `
    <span class="restaurant-name">${escapeHtml(r.name)}</span>
    <span class="last-eaten">${lastLabel}</span>
    ${left > 0 ? `<span class="cooldown-badge">還要 ${left} 餐</span>` : ''}
  `;
  return li;
}

// 午/晚餐手動切換
mealToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  manualMeal = btn.dataset.meal;
  renderNow();
});

// ---------- 偏好設定（輸入畫面：拖曳分層） ----------
function renderTiers(restaurants) {
  tierListEl.innerHTML = '';
  sortableInstances.forEach((s) => s.destroy());
  sortableInstances = [];

  TIERS.forEach((tierDef) => {
    const tierWrap = document.createElement('div');
    tierWrap.className = 'tier-block';

    const heading = document.createElement('h3');
    heading.textContent = tierDef.label;
    tierWrap.appendChild(heading);

    const ul = document.createElement('ul');
    ul.className = 'tier-ul';
    ul.dataset.tierId = tierDef.id;

    restaurants
      .filter((r) => r.tier === tierDef.id)
      .forEach((r) => ul.appendChild(renderPrefItem(r)));

    tierWrap.appendChild(ul);
    tierListEl.appendChild(tierWrap);

    const sortable = new Sortable(ul, {
      group: 'restaurants',
      animation: 200,
      handle: '.drag-handle',
      onEnd: handleReorder,
    });
    sortableInstances.push(sortable);
  });
}

function renderPrefItem(r) {
  const li = document.createElement('li');
  li.className = 'restaurant-item';
  li.dataset.id = r.id;
  li.dataset.sortKey = r.sort_key;

  const cd = r.cooldown_meals || 0;
  li.innerHTML = `
    <span class="drag-handle">⋮⋮</span>
    <span class="restaurant-name">${escapeHtml(r.name)}</span>
    <span class="restaurant-pref">${'★'.repeat(r.preference || 0)}</span>
    <span class="cooldown-info">${cd === 0 ? '不限' : '隔 ' + cd + ' 餐'}</span>
    <button class="edit-btn ghost" type="button">編輯</button>
  `;
  li.querySelector('.edit-btn').addEventListener('click', () => openEdit(r));
  return li;
}

async function handleReorder(evt) {
  const item = evt.item;
  const restaurantId = item.dataset.id;
  const newTier = parseInt(evt.to.dataset.tierId, 10);
  const newSortKey = computeNewSortKey(evt.to, item);

  item.dataset.sortKey = newSortKey;

  const { error } = await supabase
    .from('restaurants')
    .update({ tier: newTier, sort_key: newSortKey, updated_by: currentUserId })
    .eq('id', restaurantId);

  if (error) console.error(error);
}

// 用相鄰兩個項目的 sort_key 取中間值，插入不用重排整批資料
function computeNewSortKey(container, item) {
  const items = Array.from(container.children);
  const idx = items.indexOf(item);
  const prev = items[idx - 1];
  const next = items[idx + 1];
  const prevKey = prev ? parseFloat(prev.dataset.sortKey) : null;
  const nextKey = next ? parseFloat(next.dataset.sortKey) : null;
  if (prevKey === null && nextKey === null) return 0;
  if (prevKey === null) return nextKey - 1;
  if (nextKey === null) return prevKey + 1;
  return (prevKey + nextKey) / 2;
}

// ---------- 新增餐廳 ----------
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('add-name').value.trim();
  const tagsRaw = document.getElementById('add-tags').value.trim();
  const preference = parseInt(document.getElementById('add-preference').value, 10);
  const cooldownMeals = parseInt(document.getElementById('add-cooldown').value, 10) || 0;

  if (!name) return;

  const lastTier = TIERS[TIERS.length - 1].id;

  const { error } = await supabase.from('restaurants').insert({
    name,
    tags: tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [],
    preference,
    cooldown_meals: cooldownMeals,
    tier: lastTier,
    sort_key: Date.now(), // 新項目先排在該層最後面，之後可以再拖
    created_by: currentUserId,
    updated_by: currentUserId,
  });

  if (error) {
    toast('新增失敗：' + error.message, true);
    return;
  }
  addForm.reset();
  document.getElementById('add-preference').value = 3;
  document.getElementById('add-cooldown').value = 0;
  document.getElementById('add-wrap').removeAttribute('open');
  toast(`已新增 ${name}`);
});

// ---------- 編輯 / 刪除餐廳 ----------
function openEdit(r) {
  editingId = r.id;
  editErrorEl.textContent = '';
  editNameEl.value = r.name || '';
  editTagsEl.value = (r.tags || []).join(', ');
  editPrefEl.value = r.preference || 3;
  editCooldownEl.value = r.cooldown_meals || 0;
  editModal.classList.remove('hidden');
}

function closeEdit() {
  editModal.classList.add('hidden');
  editingId = null;
}

editSaveBtn.addEventListener('click', async () => {
  if (!editingId) return;
  const name = editNameEl.value.trim();
  if (!name) {
    editErrorEl.textContent = '名稱不能空白';
    return;
  }
  const tagsRaw = editTagsEl.value.trim();
  const preference = parseInt(editPrefEl.value, 10);
  const cooldownMeals = parseInt(editCooldownEl.value, 10) || 0;

  const { error } = await supabase
    .from('restaurants')
    .update({
      name,
      tags: tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [],
      preference,
      cooldown_meals: cooldownMeals,
      updated_by: currentUserId,
    })
    .eq('id', editingId);

  if (error) {
    editErrorEl.textContent = '儲存失敗：' + error.message;
    return;
  }
  closeEdit();
  toast('已更新');
});

editDeleteBtn.addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('確定刪除這間餐廳？相關歷史紀錄也會一起刪掉。')) return;

  const { error } = await supabase.from('restaurants').delete().eq('id', editingId);
  if (error) {
    editErrorEl.textContent = '刪除失敗：' + error.message;
    return;
  }
  closeEdit();
  toast('已刪除');
});

editCancelBtn.addEventListener('click', closeEdit);
editModal.addEventListener('click', (e) => {
  if (e.target === editModal) closeEdit();
});

// ---------- 標記吃了這間 ----------
async function markEaten(restaurantId, name, dateStr, meal) {
  const { error } = await supabase.from('history_entries').insert({
    restaurant_id: restaurantId,
    eaten_date: dateStr,
    meal,
    chosen_by: currentUserId,
  });
  if (error) {
    toast('紀錄失敗：' + error.message, true);
    return;
  }
  toast(`已記錄：${name}（${shortDate(dateStr)} ${MEALS[meal]}）`);
}

// ---------- 月曆（歷史紀錄 + 補登） ----------
async function loadCalendar() {
  const first = `${calYear}-${pad(calMonth + 1)}-01`;
  const lastDayNum = new Date(calYear, calMonth + 1, 0).getDate();
  const last = `${calYear}-${pad(calMonth + 1)}-${pad(lastDayNum)}`;

  const { data, error } = await supabase
    .from('history_entries')
    .select('id, eaten_date, meal, restaurant_id, restaurants(name)')
    .gte('eaten_date', first)
    .lte('eaten_date', last)
    .order('eaten_date', { ascending: true });

  if (error) {
    console.error(error);
    return;
  }
  calEntries = data || [];
  renderCalendar();
}

function entriesByDate() {
  const map = {};
  calEntries.forEach((e) => {
    if (!map[e.eaten_date]) map[e.eaten_date] = { lunch: [], dinner: [] };
    (map[e.eaten_date][e.meal] || (map[e.eaten_date][e.meal] = [])).push(e);
  });
  return map;
}

function renderCalendar() {
  calTitleEl.textContent = `${calYear} 年 ${calMonth + 1} 月`;
  const map = entriesByDate();
  const firstWeekday = new Date(calYear, calMonth, 1).getDay(); // 0=日
  const lastDayNum = new Date(calYear, calMonth + 1, 0).getDate();
  const todayStr = localDateStr(new Date());

  let html = '<div class="cal-grid">';
  ['日', '一', '二', '三', '四', '五', '六'].forEach((w) => {
    html += `<div class="cal-weekday">${w}</div>`;
  });
  for (let i = 0; i < firstWeekday; i++) html += '<div class="cal-cell empty"></div>';

  for (let day = 1; day <= lastDayNum; day++) {
    const dateStr = `${calYear}-${pad(calMonth + 1)}-${pad(day)}`;
    const dayData = map[dateStr] || { lunch: [], dinner: [] };
    const isToday = dateStr === todayStr;
    html += `
      <div class="cal-cell${isToday ? ' today' : ''}" data-date="${dateStr}">
        <div class="cal-day">${day}</div>
        ${mealMini('午', dayData.lunch)}
        ${mealMini('晚', dayData.dinner)}
      </div>`;
  }
  html += '</div>';
  calendarEl.innerHTML = html;

  calendarEl.querySelectorAll('.cal-cell[data-date]').forEach((cell) => {
    cell.addEventListener('click', () => openDay(cell.dataset.date));
  });
}

function mealMini(label, entries) {
  if (!entries || entries.length === 0) return '';
  const names = entries.map((e) => escapeHtml(e.restaurants?.name || '?')).join('、');
  return `<div class="cal-meal"><b>${label}</b>${names}</div>`;
}

function openDay(dateStr) {
  dayTitleEl.textContent = `${shortDate(dateStr)}（${weekdayLabel(dateStr)}）登記`;
  const map = entriesByDate();
  const dayData = map[dateStr] || { lunch: [], dinner: [] };

  daySlotsEl.innerHTML = MEAL_ORDER.map((meal) => {
    const entries = dayData[meal] || [];
    const rows = entries
      .map(
        (e) => `
        <div class="day-entry">
          <span>${escapeHtml(e.restaurants?.name || '（已刪除）')}</span>
          <button type="button" class="del-entry danger" data-id="${e.id}">刪除</button>
        </div>`
      )
      .join('');
    const options = allRestaurants
      .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
      .join('');
    return `
      <div class="day-slot" data-meal="${meal}">
        <h4>${MEALS[meal]}</h4>
        ${rows || '<div class="day-empty">還沒登記</div>'}
        <div class="day-add">
          <select class="day-select">${options}</select>
          <button type="button" class="day-add-btn">新增</button>
        </div>
      </div>`;
  }).join('');

  // 綁事件
  daySlotsEl.querySelectorAll('.del-entry').forEach((btn) => {
    btn.addEventListener('click', () => deleteEntry(btn.dataset.id, dateStr));
  });
  daySlotsEl.querySelectorAll('.day-slot').forEach((slotEl) => {
    const meal = slotEl.dataset.meal;
    const select = slotEl.querySelector('.day-select');
    slotEl.querySelector('.day-add-btn').addEventListener('click', () => {
      if (!select.value) {
        toast('先去偏好設定新增餐廳', true);
        return;
      }
      const name = allRestaurants.find((r) => r.id === select.value)?.name || '';
      addEntry(select.value, name, dateStr, meal);
    });
  });

  dayModal.classList.remove('hidden');
}

function closeDay() {
  dayModal.classList.add('hidden');
}

async function addEntry(restaurantId, name, dateStr, meal) {
  const { error } = await supabase.from('history_entries').insert({
    restaurant_id: restaurantId,
    eaten_date: dateStr,
    meal,
    chosen_by: currentUserId,
  });
  if (error) {
    toast('登記失敗：' + error.message, true);
    return;
  }
  toast(`已登記：${name}（${shortDate(dateStr)} ${MEALS[meal]}）`);
  await loadCalendar();
  openDay(dateStr); // 重開以刷新這天的內容
}

async function deleteEntry(id, dateStr) {
  const { error } = await supabase.from('history_entries').delete().eq('id', id);
  if (error) {
    toast('刪除失敗：' + error.message, true);
    return;
  }
  toast('已刪除一筆紀錄');
  await loadCalendar();
  openDay(dateStr);
}

calPrevBtn.addEventListener('click', () => {
  calMonth--;
  if (calMonth < 0) {
    calMonth = 11;
    calYear--;
  }
  loadCalendar();
});
calNextBtn.addEventListener('click', () => {
  calMonth++;
  if (calMonth > 11) {
    calMonth = 0;
    calYear++;
  }
  loadCalendar();
});
dayCloseBtn.addEventListener('click', closeDay);
dayModal.addEventListener('click', (e) => {
  if (e.target === dayModal) closeDay();
});

// ---------- 即時同步：爸媽在他們手機上改，這邊自動刷新 ----------
function subscribeRealtime() {
  supabase
    .channel('public:restaurants')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurants' }, loadRestaurants)
    .subscribe();

  supabase
    .channel('public:history_entries')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'history_entries' }, () => {
      loadRestaurants(); // last_eaten_slot 會變，現在吃什麼要重算
      loadCalendar();
    })
    .subscribe();
}

// ---------- 小工具 ----------
function pad(n) {
  return String(n).padStart(2, '0');
}
function localDateStr(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function shortDate(dateStr) {
  // 'YYYY-MM-DD' -> 'M/D'
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}
function weekdayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2200);
}

checkSession();
