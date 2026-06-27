# Group Trip Planner

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zhousizhi666-coder/group-trip-planner)

一个多人共创旅行行程工具。当前内置澳洲 10 晚示例，支持：

- 输入基础旅行约束
- 按城市/地点查看行程详情
- 收集同行人的想法
- 调用火山引擎 Ark 模型生成新版行程
- 在行程总览里标记 AI 更新过的城市模块

## 本地运行

1. 复制环境变量示例：

```bash
cp .env.example .env.local
```

2. 编辑 `.env.local`，填入你的火山引擎 API Key：

```bash
VOLCENGINE_API_KEY=你的火山引擎APIKey
ARK_MODEL=ep-m-20260604202245-c2cq2
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

## 注意

- 不要提交 `.env.local`。
- 当前版本使用本地 JSON 文件保存建议和最近一次生成结果，适合轻量试用。
- 如果要长期多人使用，建议把存储迁移到 Postgres / Supabase / Neon。
