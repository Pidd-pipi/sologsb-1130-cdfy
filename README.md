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
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

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
        ├── types/{shot,frame,prop,take,sync}.ts   # 5 个数据模型（sync 为交接修订戳/待整理/交接包）
        ├── stores/{shotStore,frameStore,uiStore,syncStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog,Handover}.vue
        ├── router/index.ts
        ├── utils/{frameMath,exposure,format,device,syncStamp}.ts
        ├── sync/{engine,resolve}.ts                # 交接包导出/合并引擎与待整理解决动作
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
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
| `/handover` | 拍摄交接 | 生成/粘贴可复制 JSON 交接包，双机离线改动按设备标识与顺序号合并 |

## 双机拍摄交接

两台机器离线轮流记录同一镜头，回到网络后用可粘贴的 JSON 交接包合并，不再整包覆盖：

- **改动可溯源**：镜头 / 帧 / 道具 / 实拍每条记录带稳定标识 `syncUid` 与修订戳（设备标识 + 单调顺序号），每次本地改动只推进对应字段组的戳记（帧曝光、帧位移、道具帧区间、道具位置分组）。
- **直接并入**：不同帧、不同道具、不同日期的实拍记录自动并入；重复交换同一包按顺序号幂等去重。
- **冲突并列保留**：同一帧的曝光参数、同一道具的帧区间两边都改过时，本机数据保持不动，他机版本进「待整理」并列展示，人工「采用本机 / 采用他机」后才落定。
- **帧序联动**：帧序变化后以他机帧序为骨架并入本地独有帧，自动重排帧号；超出新帧序的道具区间标记待整理并提示重算；镜头时长/区间与实拍剩余张数、完成百分比同步重算。
- **找不到落点**：引用了不存在镜头的帧/道具/实拍标记为待整理，可手动挂到镜头（帧排到帧序末尾）或丢弃。
- **容量与失败保护**：交接包超过 1000 项时先用 StorageManager 预检本机余量，不足则整单拒绝、原记录保留；导入在单事务内完成，中途失败自动回滚，恢复后可直接重试。
- **旧数据升级**：IndexedDB `v4` 迁移为老记录补齐 `syncUid` 与空修订戳，原有页面照常工作。

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、待整理五张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加 `pending`（待整理）表，并为旧数据补齐交接字段（`syncUid`、分组修订戳）。
- **localStorage**：新建镜头表单与批量曝光参数草稿（键前缀 `gbstopmotion:draft:`），以及本机设备标识、设备名与顺序号水位（`gbstopmotion:device*`）。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
- **测试**：`npm run test`（Vitest + fake-indexeddb，覆盖双机合并、冲突并列、待整理、容量拒绝、失败回滚重试与 v3→v4 迁移）。
