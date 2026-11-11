# 开发与测试

项目维护的应用、运维和测试脚本统一使用 TypeScript，通过 `tsx` 执行。`scripts/` 也纳入 `pnpm typecheck`；不再维护 Python、Shell 或 JavaScript 脚本。Node.js、依赖包和前端构建产物仍使用 JavaScript 运行。

pnpm workspace：`packages/web` 是 React 前端，`packages/backend` 是 Koa API，`packages/shared` 是共用的日期与 URL 逻辑。

```sh
pnpm test
pnpm typecheck
pnpm test:sqlite
pnpm test:mysql
pnpm --filter @likes/web build
```

SQLite 和 MySQL 集成测试各包含 72 项 API 冒烟检查和 30 项扩展检查，覆盖收藏、判重、评论、标签、观看区间、回收站、历史导入、归档、Token、事务与附件。测试创建临时数据库，结束后删除，不使用应用配置中的业务库。

MySQL 测试默认连接本机 `root` 空密码，可设置 `TEST_MYSQL_HOST`、`TEST_MYSQL_PORT`、`TEST_MYSQL_USER`、`TEST_MYSQL_PASSWORD`。测试账号需要建库和删库权限。CI 使用独立 MySQL 5.7 服务。

数据库迁移由启动过程执行。MySQL SQL 保持 5.7 兼容；SQLite 由同一套迁移生成表结构。写入后清空读缓存，日期字段保留字符串。观看日期区间才是周视图的依据，收藏日期仅表示录入时间。

```sh
pnpm status
pnpm log
pnpm stop
```

提交前运行 `pnpm check-secrets`。真实环境配置、口令、Cookie、数据库、附件和日志不得进入版本管理。发布导出方法见 [发布流程](releasing.md)。

服务管理入口是 `scripts/local/manage.ts`。macOS 通过 launchd 运行服务，其它 Unix 系统使用 Node detached 进程组。启动前检查端口归属，状态以 pgid 判断是否脱离会话；配置和运行环境文件只保存在私有数据目录。
