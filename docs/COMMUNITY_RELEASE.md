# GitHub 与 SillyTavern 社区发布

## 1. 填入 GitHub 仓库地址

创建公开仓库后，在本项目根目录执行：

```powershell
npm run prepare:repo -- --repository-url https://github.com/你的用户名/rp-cinematic-imagegen
npm run check
```

该命令会同步更新 `manifest.json`、`package.json` 和 `docs/community-entry.json`，不会读取或写入任何 API Key。

## 2. 首次推送

```powershell
git init -b main
git add .
git commit -m "Release v2.9.21"
git remote add origin https://github.com/你的用户名/rp-cinematic-imagegen.git
git push -u origin main
```

如果目录已经是 Git 仓库，跳过 `git init`。提交前务必检查 `git status` 和 `git diff --cached`。

## 3. 创建 Release

```powershell
git tag v2.9.21
git push origin v2.9.21
```

GitHub Actions 会运行发布校验、生成 ZIP 与 SHA-256，并创建 GitHub Release。

Release 会同时提供 `rp-cinematic-imagegen-tavern-helper-installer-v2.9.21.json`。在 Discord 等社区分享时，可直接上传这个 JSON，并注明：“酒馆助手 → 脚本库 → 导入为全局脚本”；脚本默认启用并立即安装完整扩展，旧目录会在新版本安装成功后自动迁移清理，旧设置只在正式配置尚未完成时迁入。

## 4. 验证酒馆安装

在一个干净的 SillyTavern 最新 release 环境中，打开“扩展” → “安装扩展”，粘贴仓库 URL。确认：

- 能识别名称和版本；
- 页面刷新后能加载设置面板；
- 消息操作按钮与悬浮工作台正常；
- 至少一个你公开声明支持的图片后端正常；
- 仓库和 ZIP 中不包含密钥、用户设置、聊天、角色卡或生成图片。

## 5. 投稿官方内容索引

SillyTavern 官方内容仓库要求扩展开源、使用自由许可证、兼容最新 release、文档完整且不依赖服务器插件。本项目使用 MIT 许可证且为纯前端扩展。

1. Fork `SillyTavern/SillyTavern-Content`。
2. 把 `docs/community-entry.json` 的对象追加到其 `extensions.json` 数组末尾。
3. 按上游说明运行 `generate_index_json.py`。
4. 提交变更，并向上游 `main` 分支创建 Pull Request。

提交前再次阅读上游 README，以其最新要求为准。
