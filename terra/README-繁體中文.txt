TERRA — 可攜式網站包

包含完整靜態網站、互動地圖、195 國基本資料、其他地區資料、250 面國旗及 24 項世界之最。

啟動：
1. 解壓縮 ZIP。
2. 在解壓後的資料夾執行：python -m http.server 8080
3. 瀏覽器開啟 http://localhost:8080
請透過 HTTP 開啟；直接雙擊 index.html 會因瀏覽器安全限制無法載入 JSON 資料。

部署：將整個資料夾部署至任意支援靜態網站的主機，入口為 index.html。不需要 API 金鑰或後端。

主要檔案：
index.html — 頁面結構
style.css — 外觀、字體與響應式版面
app.js — 互動地圖、洲別篩選、國家卡與世界之最
countries.json — 國家與地區資料
world.json — 簡化後地圖邊界
records.json — 世界之最、定義及來源
flags/ — 國旗 SVG
terrain.png — 預先投影處理的地形圖

網站素材均已附上；Google Fonts 字體需要網路，無網路時會使用系統字體。
國家及世界之最資料來源請見網站「資料來源與收錄說明」及各紀錄的來源連結。
地圖：Natural Earth / geo-countries；國旗：flagcdn；照片：Unsplash；程式庫：D3。
此包不包含帳號憑證、Git 紀錄或原 Sites 的部署識別。
