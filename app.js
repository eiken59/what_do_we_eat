import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
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
const tagFilterEl = document.getElementById('tag-filter');
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
let allRestaurants = []; // restaurants_with_status 的 rows（含 last_eaten_slot）
let manualMeal = null; // null = 用時間自動判斷；否則 'lunch' / 'dinner'
let selectedTags = new Set(); // 現在吃什麼的標籤 filter，空 = 全部
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
    .order('preference', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true });

  if (error) {
    console.error(error);
    return;
  }
  allRestaurants = data || [];
  renderNow();
  renderPreferenceList(allRestaurants);
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

  renderTagFilter();

  const matchTags = (r) =>
    selectedTags.size === 0 || (r.tags || []).some((t) => selectedTags.has(t));
  const pool = allRestaurants.filter(matchTags);

  // 可吃清單：先濾掉冷卻中的，再依偏好度由高到低排名。
  // 同偏好度 = 同名次（標準競賽排名，會出現 1, 2, 2, 4, 5）；同分內再依名稱排，純顯示順序。
  const available = pool
    .filter((r) => isAvailable(r, slot))
    .sort(
      (a, b) =>
        (b.preference || 0) - (a.preference || 0) ||
        (a.name || '').localeCompare(b.name || '', 'zh-Hant')
    );
  available.forEach((r, i) => {
    r._rank =
      i === 0 || (r.preference || 0) !== (available[i - 1].preference || 0)
        ? i + 1
        : available[i - 1]._rank;
  });

  const cooling = pool
    .filter((r) => !isAvailable(r, slot))
    .sort(
      (a, b) =>
        (b.preference || 0) - (a.preference || 0) ||
        (a.name || '').localeCompare(b.name || '', 'zh-Hant')
    );

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
    <span class="rank-num">${r._rank}</span>
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

// 標籤 filter：蒐集所有餐廳用過的標籤，做成可多選的 chip；空 = 全部
function renderTagFilter() {
  const tags = [...new Set(allRestaurants.flatMap((r) => r.tags || []))].sort();
  tagFilterEl.innerHTML = '';
  if (tags.length === 0) {
    tagFilterEl.classList.add('hidden');
    return;
  }
  tagFilterEl.classList.remove('hidden');

  const makeChip = (label, active, tagVal) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-chip' + (active ? ' active' : '');
    b.textContent = label;
    b._tag = tagVal; // null = 「全部」
    return b;
  };

  tagFilterEl.appendChild(makeChip('全部', selectedTags.size === 0, null));
  tags.forEach((t) => tagFilterEl.appendChild(makeChip(t, selectedTags.has(t), t)));
}

tagFilterEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.tag-chip');
  if (!btn) return;
  const t = btn._tag;
  if (t === null) selectedTags.clear();
  else if (selectedTags.has(t)) selectedTags.delete(t);
  else selectedTags.add(t);
  renderNow();
});

// ---------- 偏好設定（輸入畫面：依分數自動分組，不能拖） ----------
function renderPreferenceList(restaurants) {
  tierListEl.innerHTML = '';

  if (restaurants.length === 0) {
    tierListEl.innerHTML =
      '<p class="empty-hint">還沒有餐廳，用下面的「＋ 新增餐廳」加幾間。</p>';
    return;
  }

  // 依偏好分數 5→1 分組，未評分擺最後；標題唯讀，順序由分數決定，不能拖
  const groups = [5, 4, 3, 2, 1].map((score) => ({
    label: '★'.repeat(score),
    items: restaurants.filter((r) => (r.preference || 0) === score),
  }));
  const unrated = restaurants.filter((r) => !r.preference);
  if (unrated.length) groups.push({ label: '未評分', items: unrated });

  groups.forEach((g) => {
    if (g.items.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'tier-block';

    const heading = document.createElement('h3');
    heading.textContent = g.label;
    wrap.appendChild(heading);

    const ul = document.createElement('ul');
    ul.className = 'tier-ul';
    g.items
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'))
      .forEach((r) => ul.appendChild(renderPrefItem(r)));

    wrap.appendChild(ul);
    tierListEl.appendChild(wrap);
  });
}

function renderPrefItem(r) {
  const li = document.createElement('li');
  li.className = 'restaurant-item';
  li.dataset.id = r.id;

  const cd = r.cooldown_meals || 0;
  li.innerHTML = `
    <span class="restaurant-name">${escapeHtml(r.name)}</span>
    <span class="restaurant-pref">${'★'.repeat(r.preference || 0)}</span>
    <span class="cooldown-info">${cd === 0 ? '不限' : '隔 ' + cd + ' 餐'}</span>
    <button class="edit-btn ghost" type="button">編輯</button>
  `;
  li.querySelector('.edit-btn').addEventListener('click', () => openEdit(r));
  return li;
}

// ---------- 新增餐廳 ----------
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('add-name').value.trim();
  const tagsRaw = document.getElementById('add-tags').value.trim();
  const preference = parseInt(document.getElementById('add-preference').value, 10);
  const cooldownMeals = parseInt(document.getElementById('add-cooldown').value, 10) || 0;

  if (!name) return;

  const { error } = await supabase.from('restaurants').insert({
    name,
    tags: tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [],
    preference,
    cooldown_meals: cooldownMeals,
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
  loadRestaurants(); // 不等 Realtime，立刻刷新（原本要手動 reload 才會出現）
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
  loadRestaurants();
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
  loadRestaurants();
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
  loadRestaurants(); // 吃完立刻從「可吃」清單掉下去，才有回饋
  loadCalendar();
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
  loadRestaurants(); // last_eaten 變了，現在吃什麼要重算
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
  loadRestaurants();
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
