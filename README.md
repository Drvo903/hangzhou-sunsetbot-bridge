# Hangzhou SunsetBot Bridge

无人值守读取 SunsetBot 的杭州“今天/明天 × 日出/日落 × EC/GFS”预报，并发布为静态 JSON。

## JSON 地址

启用 GitHub Pages 后：`https://<你的用户名>.github.io/hangzhou-sunsetbot-bridge/hangzhou.json`

## 首次启用

1. 在仓库 Settings → Pages 中，将 Source 设为 **GitHub Actions**。
2. 打开 Actions → **Collect SunsetBot data** → Run workflow。
3. 采集成功后检查 `public/hangzhou.json`，随后检查 Pages 地址。

定时工作流按北京时间 08:45、10:20、13:50、16:20、20:45、22:20 运行。GitHub 对定时任务可能有数分钟延迟。

采集失败会自动重试三次，并上传保留七天的 `sunsetbot-debug` 诊断包。脚本不使用账号、Cookie 或密钥。
