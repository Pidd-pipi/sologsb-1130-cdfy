# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿、设备标识与顺序号） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

交接包为带 `-----BEGIN/END GBSTOPMOTION HANDOFF-----` 标记的 JSON 文本（含 FNV-1a 校验和），可直接粘进聊天工具传递。

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take,handoff}.ts    # 5 个数据模型（handoff 为交接字段）
        ├── stores/{shotStore,frameStore,uiStore}.ts
        ├── handoff/                                   # 交接包：设备身份 / 编解码 / 合并引擎 / 导入导出 / 待整理
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog,HandoffCenter}.vue
        ├── router/index.ts
        ├── utils/{frameMath,exposure,format}.ts
        └── db/{index,api}.ts                          # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数 |
| `/handoff` | 拍摄交接中心 | 生成 / 粘贴可复制的拍摄交接包，两台机器离线改动回网后合并；处理冲突并列项与待整理条目 |

## 双机离线交接

两台机器轮流离线记录同一镜头（一台排帧挪道具、另一台登记实拍），回网后在「拍摄交接」页粘贴交接包合并，不再整包覆盖：

- **改动带设备标识与顺序号**：每条曝光 / 帧序 / 道具 / 实拍改动记录 `deviceId + seq`（本机从 1 连续递增），导入按 `(deviceId, seq)` 幂等去重、检查顺序号缺口。
- **直接并入**：不同帧、不同道具、不同实拍条目的改动无冲突直接并入。
- **并列保留**：同一帧曝光分组或同一道具区间两边都改过且都未看到对方版本时，两边的值并列进「待整理」；**选定前本机数据不改动**，可采用本机 / 采用对方（记为一次本机改动）/ 忽略。
- **帧序变化**：帧按稳定 uid 对位重排，镜头帧区间与时长自动重算；道具轨迹失效重算（越界区间夹回新帧序并标「待重算」，整体落空的进待整理）；实拍剩余张数 / 完成百分比同步更新。
- **找不到落点**：镜号 / 帧 / 道具对不上的条目标为待整理，可指定镜头人工认领，不会静默丢弃。
- **容量保护**：交接包超过 1000 项且预估导入后超过本机容量（默认 50000 行，可在页面调整）时拒绝导入并保留原记录；任何落库失败都在单事务内回滚，原记录恢复后可原样重试。
- **旧数据升级**：Dexie `v4` 迁移为旧帧 / 道具 / 实拍补齐 `uid / rev / lastChange / trajectory` 交接字段，原有页面照常工作。

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、已应用交接操作、待整理六张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加 `handoffOps` / `pending` 表并为旧行补齐交接字段（未来表在旧版本以 `null` 声明，升级时不重建清空既有数据）。
- **localStorage**：新建镜头表单与批量曝光参数草稿（`gbstopmotion:draft:` 前缀），以及交接设备标识 / 设备名 / 顺序号 / 容量。
- 纯合并逻辑见 `src/handoff/merge.ts`（无 DOM / DB 依赖），`npm test` 覆盖合并规则、交接包校验、容量拒绝、失败回滚重试与 v3→v4 升级。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
