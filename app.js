import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, TIERS } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const tierListEl = document.getElementById('tier-list');
const addForm = document.getElementById('add-form');
const historyListEl = document.getElementById('history-list');

let currentUserId = null;
let sortableInstances = [];

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
  loadHistory();
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
  });
});

// ---------- 排序清單 ----------

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
  renderTiers(data || []);
}

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
      .forEach((r) => ul.appendChild(renderRestaurantItem(r)));

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

function renderRestaurantItem(r) {
  const li = document.createElement('li');
  li.className = 'restaurant-item' + (r.is_available ? '' : ' unavailable');
  li.dataset.id = r.id;
  li.dataset.sortKey = r.sort_key;

  const daysLeft = r.is_available
    ? null
    : r.cooldown_days - Math.floor((Date.now() - new Date(r.last_eaten_date)) / 86400000);

  li.innerHTML = `
    <span class="drag-handle">⋮⋮</span>
    <span class="restaurant-name">${escapeHtml(r.name)}</span>
    <span class="restaurant-pref">${'★'.repeat(r.preference || 0)}</span>
    ${daysLeft && daysLeft > 0 ? `<span class="cooldown-badge">還要 ${daysLeft} 天</span>` : ''}
    <button class="eat-btn" data-id="${r.id}">今天吃這間</button>
  `;

  li.querySelector('.eat-btn').addEventListener('click', () => markEaten(r.id));
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
  const cooldownDays = parseInt(document.getElementById('add-cooldown').value, 10);

  if (!name) return;

  const lastTier = TIERS[TIERS.length - 1].id;

  const { error } = await supabase.from('restaurants').insert({
    name,
    tags: tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [],
    preference,
    cooldown_days: cooldownDays,
    tier: lastTier,
    sort_key: Date.now(), // 新項目先排在該層最後面，之後可以再拖
    created_by: currentUserId,
    updated_by: currentUserId,
  });

  if (error) {
    alert('新增失敗：' + error.message);
    return;
  }
  addForm.reset();
  document.getElementById('add-preference').value = 3;
  document.getElementById('add-cooldown').value = 0;
  document.querySelector('[data-tab="tier"]').click();
});

// ---------- 標記今天吃這間 ----------

async function markEaten(restaurantId) {
  const { error } = await supabase.from('history_entries').insert({
    restaurant_id: restaurantId,
    chosen_by: currentUserId,
  });
  if (error) {
    alert('紀錄失敗：' + error.message);
  }
}

// ---------- 歷史紀錄 ----------

async function loadHistory() {
  const { data, error } = await supabase
    .from('history_entries')
    .select('id, eaten_date, restaurants(name)')
    .order('eaten_date', { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    return;
  }
  renderHistory(data || []);
}

function renderHistory(entries) {
  historyListEl.innerHTML = entries
    .map(
      (e) =>
        `<li><span class="history-date">${e.eaten_date}</span>${escapeHtml(
          e.restaurants?.name || '（餐廳已刪除）'
        )}</li>`
    )
    .join('');
}

// ---------- 即時同步：爸媽在他們手機上改，這邊自動刷新 ----------

function subscribeRealtime() {
  supabase
    .channel('public:restaurants')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurants' }, loadRestaurants)
    .subscribe();

  supabase
    .channel('public:history_entries')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'history_entries' }, () => {
      loadHistory();
      loadRestaurants();
    })
    .subscribe();
}

// ---------- 小工具 ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

checkSession();
