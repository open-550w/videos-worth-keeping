# 配置与数据

## 数据位置

默认所有应用数据都在项目的 `.data/`（Git 忽略）中：

```text
.data/
  config/default.env       # 配置、数据库凭据、ACCESS_TOKEN（权限 0600）
  db/default.sqlite        # SQLite 文件
  uploads/default/         # 附件
  cache/default/           # B 站 Cookie、详情缓存
  logs/                    # 服务日志
  pids/                    # 服务 PID
  tmp/                     # 上传临时文件，请求结束后清理
```

在项目根目录 `.env.local`（Git 忽略）选择存放模式：

```dotenv
# 默认：当前项目 .data/
APP_DATA_MODE=project
APP_PROFILE=default
```

```dotenv
# 个人习惯：~/.local/share/videos-worth-keeping/
APP_DATA_MODE=xdg
APP_PROFILE=default
```

```dotenv
# 自定义绝对目录
APP_DATA_MODE=custom
APP_DATA_DIR=/absolute/path/to/likes-data
APP_PROFILE=default
```

切换位置不会自动移动旧数据；先停止服务，再选择新目录。需要保留数据时，将原数据目录内容复制过去。不要让多个实例同时使用同一个数据目录。

## 切换数据库和数据集

配置 profile 就是数据源选择器，切换不会清空或迁移旧数据库：

```sh
pnpm stop
pnpm app:config use mysql
# 打开命令显示的 config/mysql.env，按下例修改
pnpm start
```

SQLite（默认，无需安装数据库服务）：

```dotenv
DB_CLIENT=sqlite
# 可省略，默认 db/<profile>.sqlite，相对数据目录
SQLITE_PATH=db/demo.sqlite
PORT=3050
WEB_PORT=5190
ACCESS_TOKEN=<自己生成的至少24位随机口令>
```

本地 MySQL（推荐给需要 MySQL 的用户）：自行创建空数据库和有建表权限的账号，然后填入同一个配置文件：

```dotenv
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=videos_worth_keeping
DB_USER=videos_worth_keeping
DB_PASSWORD='replace-me'
PORT=3050
WEB_PORT=5190
ACCESS_TOKEN=<自己生成的至少24位随机口令>
```

服务启动时自动执行版本化迁移；MySQL 保留 5.7 兼容 SQL。`DB_CLIENT` 不允许其它值，配置错误会明确报错。切回 `pnpm app:config use default` 即可重新看到原来的 SQLite 数据。附件和 B 站缓存默认也按 profile 隔离；如要与已有数据库配套，设置 `UPLOAD_DIR` / `BILI_COOKIE_PATH` 等绝对路径。数据库切换不等于跨引擎数据搬迁。

## B 站观看历史

在服务所在电脑的 Chrome 登录 B 站并启用远程调试，打开“观看历史”，点击 **刷新登录并同步**；如有调试授权提示，点击允许。之后通常只需点“同步”。页面会显示 Cookie、抓取、写库进度以及错误，可以重试。首次或过期后无需手动执行 CLI。

普通网页受浏览器同源和 HttpOnly Cookie 限制，无法直接读取 B 站登录态；实际抓取由后台任务执行。远程部署时，Chrome 必须在服务所在机器，或在私有配置里通过 `BILI_COOKIE_PATH` 指向已经准备好的 Cookie 文件。自定义 Chrome profile 可设置 `BILI_CHROME_ACTIVE_PORT_FILE`。不要将 Cookie 或真实观看数据放入 Git。

```sh
# 仍可使用 CLI，读取当前 profile 的数据库和 Cookie
pnpm fetch:bili --since 7d --refresh-cookies
```

同步只插入新的观看事件，不覆盖已有内容和归档决定。抓回来的记录进入候选区，勾选收藏后才进入收藏册。


## 访问口令与部署

访问口令在当前 profile 的 `ACCESS_TOKEN` 中，至少 24 位。网页输入口令后使用 HttpOnly Cookie；API 客户端可发送 `Authorization: Bearer <口令>`，附件也需要鉴权。不要把口令放在 URL 中。公网使用 HTTPS 反向代理，同时转发前端、`/api` 和 `/uploads`。
