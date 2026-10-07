# RP 电影配图 v2.9.57

按当前剧情、实际入镜人物和各自参考图生成配图。本次发布包含此前未公开提交的剧情状态、人物身份、视角、图库与局部精修改进，以及 v2.9.57 的失败阶段本地文字回退和当前绑定世界书上下文修正。

## 安装文件

- `rp-cinematic-imagegen-v2.9.57.zip`：基础扩展，解压到酒馆用户的 `extensions` 目录。普通用户不需要 Ollama 或9B模型。
- `rp-cinematic-imagegen-tavern-helper-installer-v2.9.57.json`：已安装酒馆助手时，导入为全局脚本并启用，用按钮安装或更新原生扩展。
- `rp-cinematic-local-scene-llm-v2.9.57.zip`：可选 Windows + NVIDIA 本地文字回退服务；不含权重或node_modules，按其中README安装依赖并导入自己的模型。
- 每个附件均提供 `.sha256` 文件，可用 `Get-FileHash -Algorithm SHA256` 核对。

也可在酒馆“安装扩展”中直接使用 [仓库地址](https://github.com/wangjinmiao147-dotcom/rp-cinematic-imagegen)。

## 变化

- 三阶段事实、演员关系、英文编辑分析；区分当前瞬间与后来事件，维护有依据的场景和服装道具状态。
- 别名解析、不同人物参考图归属、User三视图及局部入镜范围；心理气泡需当前内心情绪证据。
- 本地文字回退默认关闭：主接口失败时只补当前阶段，下一阶段重新优先主接口。取消不触发回退；云端密钥不转发；本地输出也需结构和证据校验。
- 读取当前绑定且可用世界书中的对应人物明确年龄字段；旧内嵌副本不覆盖当前绑定信息。
- 默认512档；可选整图清晰绘制和手动局部精修。清晰绘制默认关闭，普通16:9内部1024×576后完整缩至512×288，镜面仍走原绘制档。
- 玻璃与镜面区分、有限单人贴镜及双人姿态几何引导；明确视角优先于参考图的裁切和正面细节。
- 独立服务改为相对路径与可配置运行目录，提供模型来源、SHA256、Modelfile和许可证。

## 限制与隐私

代码回归和打包验证不等于所有剧情、手机、显卡或图像细节验收。复杂镜面、手足、持物和身份仍受模型影响；回退不保证任何输入都成功。

本地服务默认只监听回环地址，其他酒馆端口需配置CORS；手机上的127.0.0.1不指向电脑。插件等待时间与代理计算上限分别配置。

发布不包含私人设置、密钥、聊天、角色卡、验收日志、生成图片、模型权重、缓存或node_modules。原有用户配置保持；私有图片桥接不随包分发。详见 [README](https://github.com/wangjinmiao147-dotcom/rp-cinematic-imagegen#readme)、[本地服务说明](https://github.com/wangjinmiao147-dotcom/rp-cinematic-imagegen/blob/main/tools/local-scene-llm/README.md) 和 [更新日志](https://github.com/wangjinmiao147-dotcom/rp-cinematic-imagegen/blob/main/CHANGELOG.md)。
