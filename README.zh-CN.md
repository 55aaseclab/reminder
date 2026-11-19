# Reminder 提醒与任务

[English](README.md) · [产品需求](docs/PRD.md) · [路线图](docs/ROADMAP.md)

独立 Node.js 服务和 CLI 共用一个 JSON 存储。使用 Node 22 或更高版本；首次使用时从空示例初始化文件。

```sh
node src/cli.js import data/checklist.example.json
npm start
```

打开本机 `http://127.0.0.1:4322/` 浏览任务、标记及工时报表。也可以用 `--data` 或 `REMINDER_DATA` 指定私有数据文件，在 CLI 和服务进程中使用相同路径。运行 `node src/cli.js help` 查看命令；`npm test` 使用隔离的合成数据。连接 Praxis 时使用受管接口及空间级访问配置。

## Praxis 集成

应用维护的[供数合同](docs/PRAXIS-PROVIDER.md)提供按授权过滤、有来源依据的卡片与数据源描述，不增加 HTTP 元数据入口。使用 `npm run test:provider` 验证隔离供数测试。
