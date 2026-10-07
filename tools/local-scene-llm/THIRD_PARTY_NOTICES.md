# 作者、依赖与模型来源

RP 电影配图由 RP 电影配图 contributors 维护，扩展及本地辅助服务代码使用 [MIT](LICENSE)。维护者账户为 `wangjinmiao147-dotcom`。模型、工具和文档各归其作者，本项目不代表上游。

| 依赖 | 用途 | 许可证 / 作者 |
|---|---|---|
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) 6.2.5（锁定版本） | 基础扩展开发测试，不进入运行 ZIP | Apache-2.0 / dumbmatter contributors |
| [pinyin-pro](https://github.com/zh-lx/pinyin-pro) 3.29.4 | 可选本地服务中文姓名还原 | MIT / zh-lx，版权 2022-present |

`pinyin-pro` 通过 `npm ci` 安装，不随 ZIP 分发；独立服务提供 `licenses/pinyin-pro-MIT.txt`。锁定文件保留 npm 完整性值。

## 可选模型（不分发权重）

- [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)：Qwen 团队，Apache-2.0。
- [huihui-ai/Huihui-Qwen3.5-9B-abliterated](https://huggingface.co/huihui-ai/Huihui-Qwen3.5-9B-abliterated)：huihui-ai，模型卡标注 Apache-2.0。
- [mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF](https://huggingface.co/mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF)：mradermacher 量化，模型卡标注 Apache-2.0。

`abliterated` 沿用来源名称，不保证所有输入成功、不会拒绝或输出准确。本项目仅提供导入说明和 SHA256，不自动下载或重发布权重。取得模型时阅读来源模型卡及 [原始许可证](https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE)；模型条件独立于扩展 MIT。

## 规则与协议参考

相关出处保留在文档中，不打包这些上游的服务、图像素材或模型。

- [Qwen Image 2.1](https://github.com/QwenLM/Qwen-Image-2.1) 的编辑规则。
- [ComfyUI workflow templates](https://github.com/Comfy-Org/workflow_templates) 的图片编辑流程。
- [SLAYimages](https://github.com/wewwaistyping/SLAYimages) 的逐图用途表述。
- [ComfyUI-Fisher-Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose) 的多图姿态映射思路；本项目独立生成限定场景简单几何。
- [Ollama API](https://docs.ollama.com/api/chat) 和 [FAQ](https://docs.ollama.com/faq)，包括 `keep_alive: 0` 与本机监听行为。
