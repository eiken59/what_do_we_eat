# 要吃什麼

## 1. Supabase：新增登入帳號

Dashboard → Authentication → Users → Add user，手動建立你和爸媽三個帳號（直接設密碼，不用走 email 驗證那套流程）。目前前端只有登入表單，沒有註冊表單，就是為了讓帳號只能用你在後台開的這三組。

## 2. 推到 GitHub

```
cd what-to-eat-app
git init
git add .
git commit -m "Initial commit"
git branch -M main
gh repo create what-to-eat-app --private --source=. --push
```

如果沒裝 `gh`（GitHub CLI），改成先在 github.com 手動建一個空 repo，再：

```
git remote add origin git@github.com:<你的帳號>/what-to-eat-app.git
git push -u origin main
```

## 3. Cloudflare Pages 部署

1. dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git，選這個 repo。
2. Build command 留空，Build output directory 填 `/`（這個專案沒有打包步驟，純靜態檔案）。
3. Deploy，之後每次 push 到 main 會自動重新部署。

部署好會拿到一個 `*.pages.dev` 網址，爸媽在 Safari 打開這個網址 → 分享 → 加入主畫面，就會有一個圖示。

## 待補（不影響現在能不能動，之後有空再做）

- `manifest.json` 的 `icons` 是空的，之後可以做一個實際的 App 圖示補上去。
- 目前排序畫面固定三層（最想吃／普通／先緩緩），要改層數或名稱直接改 `config.js` 裡的 `TIERS`。
