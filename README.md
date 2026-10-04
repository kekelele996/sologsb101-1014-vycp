# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts plotLedger.ts owner.ts replant.ts
        ├── stores/             # plotStore.ts surveyStore.ts ledgerStore.ts replantStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts reconcile.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 外业验收台：外业验收队按测次交回成活株数与株高、自动算成活率、低于阈值告警、重复交回去重、批量调整等级 |
| `/ledgers` | `pages/LedgerBoard.tsx` | 项目部台账对账台：只录栽植总株数，缺株数按「栽植总株数 − 最新成活株数」对账算出；对不上挂起、只重试自己那份、挂起不发补植 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看、挂起地块拦截 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引，`version(3)` 把外业验收与项目部台账分开记账：
  * v2：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM` 索引等；回填 `revision` / `createdAt` / `updatedAt`；为 `plots` 补 `missingCount`、`lastReplantDate`；为 `surveys` 补 `grade`、`gradeManual`。
  * **v3（本次）**：
    * `surveys` 增加 `owner` 归属字段，**旧记录没标来源，统一补 `owner='field'`（外业验收队）**，升上来后仍能参与对账；
    * 新增 `plotLedgers` 表（项目部地块台账），以 `[plotId+round]` 为对账唯一键；
    * **按现有测次回填项目部台账**：栽植总株数沿用栽植记录合计，缺株数按「栽植总株数 − 成活株数」算出，旧数据升级后立即可对账。
* **表结构**：

  | 表 | 主键 | 主要索引 | 归属 |
  | --- | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt | 共有 |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity | 项目部 |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM | 项目部 |
  | `surveys` | id | plotId, [plotId+round], date, grade | **外业验收队**：成活株数、株高 |
  | `plotLedgers` | id | plotId, [plotId+round], date, reconcileState | **项目部**：栽植总株数、缺株数（算出） |
  | `replants` | id | plotId, planDate, state, species | 共有 |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 → 外业验收 → 项目部台账（对账）→ 补植**：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（每地块 2 批）、6 条栽植记录（每地块 2 条，引用真实批次 id）；
  * 7 条外业验收记录（每地块 2–3 个测次，成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 7 份项目部台账（与外业测次一一对应，对账全部「一致」）、3 条补植计划（待补植 / 已补植 / 已复核）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、外业验收、项目部台账与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **成活率** = 外业成活株数 ÷ 栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **分开记账（v3 核心）**：
  * **外业验收队**只在 `surveys` 记「成活株数、平均株高」（`owner='field'`）；**项目部**只在 `plotLedgers` 记「栽植总株数」；
    两边各存各的、按「地块编号 + 测次」对账，谁后存都不再顶掉对方。
  * **缺株数 = 项目部栽植总株数 − 最新外业成活株数**（`src/utils/reconcile.ts` 纯函数算出，不由人工填写）。
* **对账与挂起**：同一地块同一测次两边对得上置「一致」；外业缺测次或成活株数多于栽植总株数时置「挂起待复核」。
  **挂起期间不为该地块生成补植计划**（验收台一键生成、补植页手动新建都会拦截），避免按过期成活率发计划；
  项目部可在台账页「重试对账」（只重试自己那份）或修正栽植总株数后重新交回，也可「复核」按最新外业记录再算。
* **离线交回去重**：
  * 外业离线交回为 **insert-if-absent**：同一地块同一测次重复交回只保留最早那一份，本次丢弃不覆盖（`submitFieldSurvey` 返回 `duplicated`）；
  * 项目部交回 / 对账失败重试为 **按 `[plotId+round]` 幂等 upsert**：只更新项目部自己这一行，**外业测次照旧不动**（`submitProjectLedger`）。
* **旧数据升级**：v3 升级给旧验收记录补外业归属，并按现有测次回填项目部台账；导入旧版 JSON 存档（无 `plotLedgers`）时同口径补建，升上来即可参与对账。
* **补植回写**：补植状态推进到「已补植」时，只扣减地块与最新一条「对账一致」台账的缺株数、写入最近补植日期；
  **不再改写外业成活株数 / 株高 / 成活率**——成活率由下一轮外业验收按「成活株数 ÷ 栽植总株数」自然更新。
