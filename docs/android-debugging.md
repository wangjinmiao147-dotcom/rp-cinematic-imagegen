# Android排错与参考图迁移

历史实机验证范围为Android 16、小米浏览器20.26、Chromium135与SillyTavern；不是所有Android、Google Chrome或WebView的兼容认证。v2.9.57发布回归不含新增Android实机验证。

## 悬浮球、图库与设置

浏览器根元素高度为零且带transform或perspective时，fixed定位可能出屏。扩展按visualViewport维护悬浮球、面板及图库，处理视口变化，并保留初始化错误用于排错。图库卡片内容滚动，大图按当前可视区域布局；中文导入导出按钮在插件范围内覆盖酒馆min-content宽度。

如按钮不可见，先检查扩展已启用、版本与模块加载，查看浏览器控制台错误。切换横竖屏及地址栏高度后再观察。不要仅以桌面移动视口模拟替代手机实测。

## 网络错误

- `EDITS_NOT_FOUND`：图片编辑路由返回404，检查服务路由与模型能力。
- `EDITS_UNSUPPORTED`：405/501，服务可能不支持图片编辑。
- `EDITS_HTTP`：上游HTTP错误，查看已脱敏的状态说明。
- `NETWORK_FAILED`：连接失败，不能仅凭Failed to fetch认定CORS；分别检查地址、端口、证书和浏览器网络日志。
- `REFERENCE_DOWNLOAD_FAILED`：参考图片下载失败，临时链接可能过期。

模型列表可读取不等于图片生成或编辑可用。有身份参考时编辑失败不会静默丢图降级为文生图。手机的127.0.0.1是手机自身，电脑本地接口需另行设计可访问网络方案。

## 参考图

参考图在当前浏览器IndexedDB中，换浏览器或设备不会自动同步。使用扩展“导出当前角色参考图包”和“导入图片 / 参考图包到当前角色”迁移完整图片、用途和启用状态。User参考图与角色卡分库。

支持JPG、PNG、WebP、GIF及JSON包，单图15MB，每批10文件、总计30MB。Android文件提供器的MIME可能缺失，扩展核对文件头；改后缀的普通文本不作为图片。数据库读取失败或取消会明确停止。

## 开发测试

普通源码回归：

```powershell
npm ci
npm test
npm run check
```

真实Android测试需USB调试、ADB和可访问的浏览器CDP：

```powershell
adb devices -l
adb shell cat /proc/net/unix
adb forward tcp:9222 localabstract:chrome_devtools_remote
npm run test:android:server
```

浏览器调试socket可能不同，应按设备实际结果设置forward。另一个终端可运行 `npm run test:android`。图库、参考图设置和导入测试分别为 `npm run test:android:gallery`、`npm run test:android:settings`、`npm run test:android:import`。不要裸跑node --test自动发现实机脚本。

脚本使用受控HTTP夹具和测试数据，不调用生产模型。测试数据库独立于用户参考图库；布局测试可能临时打开测试图库或设置页面，结束后收尾。报告文件用于本地排错，不能直接作为公开附件。

不同浏览器分别复验；回归通过、接口返回成功与生成图的像素质量是不同结论。
