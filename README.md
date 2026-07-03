# Group Trip Planner

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zhousizhi666-coder/group-trip-planner)

一个多人共创旅行行程工具。当前内置澳洲 10 晚示例，支持：

- 输入基础旅行约束
- 按城市/地点查看行程详情
- 收集同行人的想法
- 调用火山引擎 Ark 模型生成新版行程
- 在行程总览里标记 AI 更新过的城市模块
- 用飞书多维表格保存 `tripId` 下的整份行程状态

## 本地运行

1. 复制环境变量示例：

```bash
cp .env.example .env.local
```

2. 编辑 `.env.local`，填入你的火山引擎 API Key：

```bash
VOLCENGINE_API_KEY=你的火山引擎APIKey
ARK_MODEL=ep-m-20260604202245-c2cq2
LARK_APP_ID=你的飞书应用AppID
LARK_APP_SECRET=你的飞书应用AppSecret
LARK_BASE_TOKEN=C3Z1bFVfbanZlxs01uZlUQRXgLg
LARK_TRIPS_TABLE_ID=tblvQcGaN0wOwNyC
LARK_OPENAPI_BASE_URL=https://open.larksuite.com/open-apis
DEFAULT_TRIP_ID=australia-2026
```

3. 启动服务：

```bash
npm start
```

4. 打开：

```text
http://127.0.0.1:8787
```

## 部署到 Render

1. 把本目录内容上传到 GitHub 仓库根目录。
2. 在 Render 新建 Web Service，并连接这个仓库。
3. 使用以下配置：
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
4. 在 Render 环境变量中配置：
   - `VOLCENGINE_API_KEY`
   - `ARK_MODEL=ep-m-20260604202245-c2cq2`
   - `LARK_APP_ID`
   - `LARK_APP_SECRET`
   - `LARK_BASE_TOKEN=C3Z1bFVfbanZlxs01uZlUQRXgLg`
   - `LARK_TRIPS_TABLE_ID=tblvQcGaN0wOwNyC`
   - `LARK_OPENAPI_BASE_URL=https://open.larksuite.com/open-apis`
   - `DEFAULT_TRIP_ID=australia-2026`

## 飞书 Base 存储

当前推荐的主存储是飞书多维表格：

- Base: `Group Trip Planner 云存储`
- Trips 表: `tblvQcGaN0wOwNyC`
- 默认行程: `australia-2026`

网站前端不会持有飞书凭证。所有保存请求都会先发到 Render 后端，再由后端使用飞书应用身份写入 Trips 表。

## 注意

- 不要提交 `.env.local`。
- 如果没有配置飞书环境变量，服务会退回到本地 JSON 文件，适合本地调试但不适合长期多人协作。
- 生产环境不要把 `LARK_APP_SECRET` 写进前端或提交到 GitHub。
