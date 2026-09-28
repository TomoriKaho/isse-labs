# Lab 3：封帆 2300018314

## 项目与运行方式

应用来自本人 Lab 2，保留多会话与聊天记录的增删改查，以及 DeepSeek 对话功能。
Flask 在同一个容器内提供首页、静态资源和 `/api/` 接口，前端使用同源相对路径。
DeepSeek Key 只由后端从运行时环境变量 `DEEPSEEK_API_KEY` 读取，不加载 `.env`。

Dockerfile 使用 `python:3.12-slim`，工作目录为 `/app`。
先复制 `requirements.txt` 并安装依赖，再复制应用和前端。
运行命令为 `gunicorn --workers 1 --bind 0.0.0.0:5001 --timeout 120 app:app`。
`app:app` 表示 `app.py` 模块中的 Flask 对象 `app`。
单 worker 保持会话内存与 JSON 文件的一致性；120 秒超时为模型请求留出等待时间。
`EXPOSE 5001` 只描述端口，公网访问还需要 ECI 的网络配置。

聊天记录在容器运行时生成于 `data/`；不复制 Lab 2 历史聊天数据。
本实验不配置云端持久化，容器重建或删除后记录可能丢失。
`.gitignore` 排除密钥文件、虚拟环境、缓存和运行数据；
`.dockerignore` 还排除轨迹、截图与项目说明。

## ACR 云端构建

- 个人 GitHub Fork：`TomoriKaho/isse-labs`
- 个人分支：`lab3/2300018314-fengfan`
- 构建上下文：`/lab3/2300018314-fengfan/`
- Dockerfile：上下文内的 `Dockerfile`
- 实际地域、镜像仓库、版本标签与构建结果：待本次控制台操作后记录。

## ECI 配置与验证

本次尚未部署。后续记录实际地域、规格、镜像版本、公网地址和验证结果。
应用监听端口为 `5001`；启动命令使用镜像 CMD；Key 仅在容器运行时设置。
本次验证截图将在实际创建和浏览器访问后存入 `screenshots/`，不复用上次截图。

## 本地非敏感检查

已通过 Python 与 JavaScript 语法检查、首页及静态资源响应、会话与消息 CRUD、
空输入校验、缺 Key 提示及 JSON 读写检查。模型回复使用模拟，未调用真实 DeepSeek。
已短暂使用 Dockerfile 对应的 Gunicorn 命令启动应用，验证端口 5001 的页面、
静态资源与 `/api/hello` 均返回 HTTP 200，随后停止测试服务。
已核验 `.env` 忽略规则生效且未被 Git 跟踪；未读取 `.env`。
这些检查不代表 ACR 构建或 ECI 部署已经成功；云端验证将在后续完成。

## 提交与清理

真实对话轨迹由学生在实验末尾保存到 `AGENT_TRACE.md`。
PR 提交后由学生删除本次 ECI，并检查相关独立计费 EIP 的释放状态。
本次资源清理状态：尚未创建资源。
