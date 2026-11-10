# 发布流程

版本使用 `v<major>.<minor>.<patch>`，例如 `v0.1.0`。更新包版本、发布说明并通过测试后创建 tag，再创建同名 GitHub Release。

从包含私有开发历史的仓库首次开源时，使用独立的新仓库，不能推送原有历史：

```sh
pnpm check-secrets
pnpm export:public
cd .open-source/videos-worth-keeping
git init -b main
```

导出仅允许源码、脚本、包配置及公开文档。它不会包含旧 `.git`、早期私人开发记录、个人配置、数据库、Cookie、附件或日志。导出读取暂存树，因此先提交或暂存改动。

发布前检查新仓库所有提交和 tag 的作者信息，以及完整 Git 对象中的敏感信息。使用愿意公开的提交身份。仅推送新仓库的 `main` 和版本 tag，不推送原仓库的其它 refs。
