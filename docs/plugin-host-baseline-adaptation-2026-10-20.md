# 插件 Host 基线适配记录

## 来源与边界

本分支 `codex/teach-mode-host-baseline` 直接从 `ad88234a2f003aa5e47ebe5350a6ee3082039c30` 建立，保留原工作区。Host 候选版本为 `1.2.3-rc.8`。Teach Mode `0.3.0` 在独立 Git 仓库 `/home/zephyr/work/teach-mode`，沿用 memmy-plugins 单插件目录及 MPP ZIP 布局；不进入 Host 安装包。每个插件使用各自的远端仓库。

Host 只加入通用协议、生命周期、共享采集、状态展示和生成技能管理。教学编排、提示文案、网页操作、Notepad 适配、旧版执行器、迁移与业务测试在插件仓库。现有 Skill Creator 仍由 Host 提供，插件调用其指令与校验器，生成成功和试运行成功分别报告。

## 与指定基线的接口差异

| 位置 | 增量适配 | 保留的基线行为 |
| --- | --- | --- |
| createBackendServices | 加入原生服务路由、动态技能、采集租约、启动/关闭和更新生命周期 | 账号、requiredEntitlement、modelPolicy、模型/嵌入、ASR、asset-key、Registry 认证、输入根目录及 workspace |
| 清单 | 可选 description/platforms/minimumHostVersion/installMode/updateMode/conversation/requiredHostCapabilities；按需隐藏 agent 工具 | agentSkillId、pinned、topbar、surface 及既有插件默认值 |
| MCP stdio | Windows 官方原生插件、宿主 Node、常驻进程、优雅关闭、异常通知、反向 memmy/host-service | 普通本地插件默认沙箱及账号策略，远程 MCP/SSE/HTTP、secret header 与网络权限 |
| 原生信任 | Registry 可信来源、下载校验后的 SHA-256、用户 native-execution 授权同时成立 | 账号登录资格与 entitlement 另行校验；Registry 自称 nativeExecutionAllowed 不足以获得资格 |
| Host 服务 | 真实插件身份，活动调用/对话身份及模型选择；事件不能伪造 conversationId | 原有模型、ASR、asset-key 路由 |
| 数据库 | 仅新增 0032-plugin-native-trust.sql 的两列 | 0026/0027 保持原文和历史；旧未发布 0030 原型在结构确认后识别，不重复建表 |
| 采集 | 订阅现有 Computer History；用户后台意图独立保存；与旧任务录制共享互斥；原生输入队列、归一化、落盘关联 checkpoint | 现有授权、后台摘要、轮转和用户运行/暂停/停止意图 |
| 技能 | app-data/plugin-skills/active.json，按 owner 注册；文件/证据哈希、工具依赖、重名、撤下/恢复 | 工作区与内置技能优先级，包内静态技能继续用 workspace/skills 和 .memmy-plugin-owner.json |
| 对话 | /teach 经现有 Agent 技能入口；通用状态条显示插件提供的提示与操作；后台状态查询不产生对话卡片 | 基线 pinned/topbar、能力事件、surface、其他命令路由 |
| 更新 | 启动及每六小时；任务租约推迟切换；失败回滚、新权限重新确认 | 首次手动安装、主动停用状态和用户数据保留 |

Agent 的原生采集所有者每三秒由 Backend 续约；Backend 退出且三十秒无心跳后释放租约、将中断任务标为失败。插件退出、停用、卸载与正常应用关闭主动清理。反向调用启动回执丢失时，也按插件身份清理实际 Agent 资源。

片段时间范围以用户开始/结束请求为准，结束固定事件字节范围、快照及 SHA-256。采集器不健康、checkpoint 超时或无法确认完整性时标为部分可用，不伪造完整证据。关闭片段不触发生成；生成不触发执行。

## 独立构建与验证入口

主仓库 CI `.github/workflows/plugin-host-compatibility.yml` 在 Linux、Windows 独立检出运行通用检查，不读取 Teach Mode 源码。插件仓库独立运行构建/测试。Host 制品工具：

```sh
npm ci --legacy-peer-deps
npm --prefix App/memmy-agent ci --legacy-peer-deps
npm run typecheck -w @memmy/backend
npm run typecheck -w @memmy/frontend-desktop
npm --prefix App/memmy-agent run build
node scripts/plugin-host/build-conformance-kit.mjs /tmp/plugin-host-kit
```

Windows 打包额外用 MSVC/CMake 构建共享原生任务录制器，并在 staging/unpacked 检查可执行文件与哈希。正式 Host kit 由 release.published 流程读取 GitHub 实际标签和发布记录生成；开发 kit 的 release 为 null。插件发布据此生成最低 Host 版本，并继续探测运行时能力。

正式发布兼容检查通过后，流水线将 Host kit 及校验文件附加到该 GitHub Release，下载文件名增加 linux-x64 / win32-x64 后缀。插件 CI 直接消费对应平台的 ZIP URL 与 SHA-256，不依赖临时 Actions 制品的外层包装。

截至本地验证：

| 检查 | 结果与实际范围 |
| --- | --- |
| Backend 插件回归 | 29 文件，171 通过、1 跳过；覆盖基线服务、沙箱/远程 MCP、权限、文件、账号、迁移、技能与更新 |
| 共享 History 与 Agent 技能 | 扩大回归 614 通过、17 跳过；2 项微信平台测试失败。已换回 pristine ad88234a 的 History 源码，复现相同两项失败 |
| 插件 UI | 135 通过、3 跳过；既有 surface、设置、API、ASR 与新商店、状态条。HomePage 全套另有 11 项既有断言失败，pristine 基线复现相同 11 项 |
| 协议与包装 | 109 通过、2 跳过；清单 Schema、包版本、原生依赖及不夹带插件源码 |
| 构建 | Backend 类型检查、生产 Agent 和渲染器构建通过；渲染器使用 .env.example 的公开 legal origins |
| 独立插件 | 26 项业务/迁移测试及 3 项发布门槛测试通过，独立类型检查通过 |
| Windows 原生 | Go 逻辑测试、交叉编译和无桌面访问 self-test 通过；MSVC 生产录制器构建通过 |
| Windows 宿主 Node | 实际 Memmy.exe 的 Electron Node 模式、PATH 无系统 Node，通过下载/MCP/受控事件/生成/卸载保留数据；此项不包含新安装包 UI、真实桌面和真实模型 |
| 固定制品跨仓 | 在插件仓库仅消费 Host kit 与 ZIP；5 项受控链路通过。最终提交/哈希报告另随交付制品保存 |

既有失败不计作本次通过，也不以受控测试替代真实 Windows 验收。测试默认跳过的项目保留基线行为，正式跨仓输入缺失会直接失败。

## 发布尚需的外部条件

本地实现与验证不等同远端交付。创建插件独立远端仓库、推送及 Host PR 需要有效 GitHub 登录。Host 合入并正式发布后，再用无系统 Node 的 Windows 测试机完成真实模型四步对话、事件边界、试运行及独立输出核验。插件发布流程验证此证据并阻止提前发布。

云服务目前在本仓库只有 catalog/resolve/download 读取接口；实际写入发布入口和部署权限须由云服务提供，不能用本地开发 Registry 代替。插件仓库提供匿名云端回读及制品哈希检查脚本。最终远端 URL、来源提交、版本与制品 SHA-256 应记录在交付清单中。
