# Videos Worth Keeping

把值得留下的视频收起来，过些时候还能找到。

导入观看历史，挑选想收藏的视频，按观看日期回顾，也可以写评论、加标签、保存截图。数据保存在自己的电脑或服务器上，默认使用 SQLite，也支持 MySQL。

**目前只支持哔哩哔哩，未来计划支持红果短剧 App。其他平台有需要的话，欢迎 fork 下来，让 AI 帮你添加。**

## 开始使用

需要 Node.js 22.12+、pnpm 10，以及 Git。SQLite 不需要另装数据库服务。

```sh
git clone https://github.com/open-550w/videos-worth-keeping.git
cd videos-worth-keeping
pnpm install
pnpm app:config
pnpm start
```

打开 <http://localhost:5190>。`pnpm app:config` 会显示私有配置文件位置，把其中的 `ACCESS_TOKEN` 填进网页即可登录。

首次运行生成空数据库和随机口令，配置、数据库、附件与日志默认保存在项目的 `.data/`，不会提交到 Git。修改配置后用 `pnpm stop && pnpm start` 重启。

## 观看历史

先在服务所在电脑的 Chrome 登录哔哩哔哩，并启用远程调试。打开“观看历史”，点击“刷新登录并同步”；后续点击“同步”即可。同步的记录先进入候选区，勾选后才会加入收藏。

## 文档

- [数据库切换、数据目录与登录配置](docs/configuration.md)
- [开发与测试](docs/development.md)
- [v0.1.0 发布说明](docs/releases/v0.1.0.md)

## License

[MIT](LICENSE)
