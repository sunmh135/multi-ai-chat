<p align="center"><img src="assets/roundtable-launcher.png" width="96" alt="多AI聊天平台图标"></p>

# 多AI聊天平台

让多个 AI 围绕同一个问题轮流讨论。支持 DeepSeek、千问、智谱 GLM、豆包和自定义兼容接口，每位成员可设置自己的名称、模型和 API Key。

## 功能

- 拖动成员组成讨论组，自选讨论轮数。
- 流式显示发言，支持暂停、继续、停止和追问。
- 保存本机讨论记录，导出 Markdown 或打印为 PDF。
- API Key 输入框提供各平台官方获取入口。
- Windows 便携版自带运行环境和带图标的启动器。
- 不同文件夹的程序独立运行，自动选择本机端口。
- 便携版关闭最后一个网页约 10 秒后自动退出后台；刷新和多标签页不会误退出。

## Windows 用户

在本仓库 **Releases** 中下载 Windows ZIP，完整解压到新文件夹，双击 **多AI聊天平台.exe**。

首次打开没有成员或密钥。点击“添加成员”，选择平台与模型，使用“获取API”申请自己的 API Key 并保存。模型调用费用由所填 Key 对应的平台账号承担。

EXE 和旁边的 `ai-roundtable` 文件夹需要放在一起。关闭最后一个平台网页约 10 秒后，后台自动退出，届时可以移动或删除解压目录。未完成的讨论会保存为“已停止”。

## 从源码运行

需要 Node.js 24 或更新版本；没有 npm 依赖，无需 `npm install`。

```bash
git clone https://github.com/sunmh135/multi-ai-chat.git
cd multi-ai-chat/ai-roundtable
node server.mjs
```

打开 <http://127.0.0.1:8765>。直接用 Node 启动时，按 `Ctrl+C` 退出后台。

Windows 用户安装 Node.js 后，也可以在仓库根目录运行以下命令，使用端口隔离和关闭网页自动退出功能：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ai-roundtable\start-web.ps1
```

启动脚本优先使用随包提供的 `runtime/node.exe`，没有内置运行环境时使用 PATH 中的 Node.js。

## 构建 Windows 启动器和便携包

启动器 C# 源码在 `launcher/Launcher.cs`，图标在 `assets/roundtable-launcher.ico`。构建脚本使用 Windows 自带的 .NET Framework C# 编译器。

```powershell
# 只编译带图标的 EXE，输出到 dist
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-launcher.ps1

# 打包；NodeDirectory 中需包含官方 Windows x64 分发的 node.exe 和 LICENSE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -NodeDirectory "C:\path\to\node-win-x64"
```

便携 ZIP 输出到 `dist`。打包脚本只收集程序源码、资源和运行环境，创建空的数据目录，不复制已有成员、密钥、讨论记录或备份。

## 数据与使用范围

本项目面向本机个人使用。运行数据保存在 `ai-roundtable/data`，包括成员配置、API Key 和讨论记录；该目录不提交到 Git。

API Key 在本机以 JSON 保存，没有加密。请妥善保管自己的电脑和数据目录；分享软件时使用不带个人数据的 Release 包。

不要把个人数据目录提交到公开仓库。向互联网开放服务前，需要另行实现用户账号、数据隔离、额度限制和相应的上线配置。

## 许可证

原创代码采用 [MIT](LICENSE) 许可证。第三方依赖和品牌素材的说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
