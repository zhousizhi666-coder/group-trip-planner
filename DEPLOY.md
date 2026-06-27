# 澳洲行程协作网站部署说明

## 推荐：Render Web Service

1. 新建一个 GitHub 仓库，把本目录里的文件放到仓库根目录。
2. 在 Render 新建 `Web Service`，连接这个仓库。
3. 配置：
   - Runtime: `Node`
   - Build Command: 留空或 `npm install`
   - Start Command: `npm start`
4. 设置环境变量：
   - `VOLCENGINE_API_KEY`: 火山引擎 API Key
   - `ARK_MODEL`: `ep-m-20260604202245-c2cq2`
5. 部署完成后，Render 会给一个公网 URL。

## 当前存储方式

当前版本用服务端 JSON 文件保存：

- 所有人提交的建议
- 最近一次生成的新版行程

适合轻量试用。如果要长期稳定使用，后续建议换成 Supabase / Neon / Render Postgres。

## 本地测试

在仓库根目录新建 `.env.local`，内容参考：

```bash
VOLCENGINE_API_KEY=你的火山引擎key
ARK_MODEL=ep-m-20260604202245-c2cq2
```

然后启动本地服务：

```bash
cd outputs
npm start
```

然后打开：

```text
http://127.0.0.1:8787
```

调试“修改行程”的推荐路径：

1. 打开网页后进入「大家的想法」。
2. 输入一条建议，例如“墨尔本不要太早起，但仍然想保留考拉和企鹅”。
3. 点击「保存并判断影响」。
4. 点击「生成新版计划」。
5. 回到「行程总览」，点击不同城市节点，检查下方日程是否被更新。
