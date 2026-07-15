// Supabase 專案設定
// anon key 設計上就是給前端直接曝露的，靠資料庫端的 RLS 保護，不是要保密的密鑰
export const SUPABASE_URL = 'https://xmzgmjptymtljwlswhcj.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtemdtanB0eW10bGp3bHN3aGNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDA5NzUsImV4cCI6MjA5OTY3Njk3NX0.JSLzJE9q5X9zBo2QEPXixIcO7ql3w13EVU7z5MD4O-w';

// 分層清單的層級定義：想加層、改名，改這裡就好，其他程式碼不用動
export const TIERS = [
  { id: 0, label: '最想吃' },
  { id: 1, label: '普通' },
  { id: 2, label: '先緩緩' },
];
