# GitHub 与社区发布

仓库已存在：[wangjinmiao147-dotcom/rp-cinematic-imagegen](https://github.com/wangjinmiao147-dotcom/rp-cinematic-imagegen)。不用重新git init或添加origin；不强推、不覆盖已发布标签。

## 验证与GitHub发布

1. 保留工作区改动，核对远端main、标签、已有Release。
2. 使用明确清单审查公开源码、测试、文档；排除私人配置、聊天、角色卡、验收日志、权重和node_modules。测试使用虚构夹具。
3. 执行 `npm ci`、`npm run check`、`npm test`、`npm ci --prefix tools/local-scene-llm`、`npm run test:local`、`npm run build`。检查ZIP内容、导入、文档、默认值和SHA256。
4. 按审查清单暂存并检查 `git diff --cached`，提交后推送main，确认该提交的Windows / Node20 CI通过。
5. 再建立 `v2.9.57` 标签并推送；标签自动创建公开Release，不与CI同时手动重复创建。
6. 校验Release六个附件、对应SHA256、安装链接和源码提交。不同版本的旧包保留。

基础扩展、酒馆助手安装器、可选本地服务分别分发；基础扩展不要求本地9B模型。通用中文稿见 [COMMUNITY_POST.zh-CN.md](COMMUNITY_POST.zh-CN.md)，Release说明见 [RELEASE_v2.9.57.md](RELEASE_v2.9.57.md)。社区账号和具体位置由发布者选择。

## 官方扩展索引

截至2026-10-07，已核对 [SillyTavern-Content官方README](https://github.com/SillyTavern/SillyTavern-Content#extension-submissions)：开源自由许可证、兼容最新SillyTavern release、完整文档，以及基础功能不能要求服务器插件。外部文字/图片接口与可选本地服务应明确说明。该README也建议联系维护团队；索引PR不保证收录。

选定该渠道并完成兼容性核对后：

1. 核对已有条目和投稿PR，避免重复。
2. Fork官方内容仓库，使用当前上游main。
3. 将 [community-entry.json](community-entry.json) 的对象添加到 `extensions.json` 末尾。
4. 执行上游 `generate_index_json.py`，审查仅索引相关差异。
5. 创建向上游main的PR，说明依赖、安装、功能与验证范围，等待维护者审查。

## Discord或其他社区

先选择服务器、论坛和频道，再阅读该位置的最新官方置顶、发布规范及附件限制。通用稿按规则调整后提交，不擅用未指定账号。使用虚构且公开的演示资料，不使用私人聊天截图或生成图。
