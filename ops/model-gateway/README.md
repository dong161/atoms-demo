# 模型网关（运行在作者本机）

线上服务（Render）需要调用大模型，但模型服务跑在作者本机。这里的两个脚本负责安全地把它接到公网：

- `gateway.mjs`：只放行 `POST /v1/chat/completions` 和 `GET /v1/models`；独立令牌鉴权、模型白名单、请求体 ≤1MB、并发上限。上游 key 只留在本机，不经过公网。
- `tunnel-supervisor.mjs`：启动 Cloudflare 临时隧道（TCP/http2），拿到新地址后先自测，再凭网关令牌调用线上 `POST /api/admin/llm-endpoint` 上报；每 2 分钟探测，连续 3 次失败就重建隧道。

守护脚本同时每 10 分钟访问一次线上 `/api/health`，作为 GitHub 定时保活之外的第二层保活。

两者用 macOS launchd 托管（开机自启、退出自动拉起）。配置复制 `gateway.config.example.json` 为 `gateway.config.json` 填写，不要提交。

隧道不可用时，线上首轮生成会退回演示数据，修改会提示失败并保留当前版本——网站本身不受影响。
