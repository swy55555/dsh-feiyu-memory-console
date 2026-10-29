# memvec（随插件附带的源码）

本地记忆向量库 + 遗忘曲线服务。给「大肥鱼的记忆」提供 `127.0.0.1:9881`。

实现细节（技术选型、数据模型、检索公式、遗忘曲线、参考文献）见 [`docs/memvec.md`](../docs/memvec.md)。

这里只放**源码**，不包含：

- `memories.db`（你的聊天记忆）
- `hfcache/`（约 90MB 的 embedding 模型）
- 日志
- 任何本地启动快捷方式或绝对路径

## 依赖

- Python 3.10+
- `pip install -r requirements.txt`

首次启动会下载 `BAAI/bge-small-zh-v1.5`（约 90MB）到 `hfcache/`，之后离线加载。也可以把已有的 `hfcache/` 放到本目录，或设置 `MEMVEC_CACHE_PATH` 指向它。

## 推荐启动（0.7.2）

在插件根目录执行 `npm run doctor`，依赖就绪后运行 `npm run start:memvec`。启动器将库和缓存对齐到控制台的数据目录，不会自动搬迁旧库。

下面的直接 Python 启动方式为旧兼容方式，默认仍使用源码同目录的库；与控制台一起使用时，必须设置一致的数据路径。

## 启动

```powershell
cd <插件目录>\memvec
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python server.py
```

数据库默认写在同目录 `memories.db`。想放在别处：

```powershell
$env:MEMVEC_DB_PATH = "$env:USERPROFILE\.dsh\memvec\memories.db"
$env:MEMVEC_CACHE_PATH = "$env:USERPROFILE\.dsh\memvec\hfcache"
.\.venv\Scripts\python server.py
```

端口默认 `9881`，只监听 `127.0.0.1`。

## 接口

- `POST /add`：加一条记忆
- `POST /search`：按 scope + query 召回
- `POST /related`：同主题/事实关联
- `POST /decay`：衰减/归档
- `GET /stats`：总数、scope、平均强度

遗忘强度按 scope 分：管理员私聊默认 180 天，群聊/非管理员私聊 2 天。可用环境变量覆盖：

```text
MEMVEC_OWNER_STRENGTH_DAYS=180
MEMVEC_OTHER_STRENGTH_DAYS=2
MEMVEC_STRENGTH_CAP_DAYS=365
```

## 隐私

这个目录只包含代码。运行时生成的 `memories.db`、`hfcache/`、日志都在本机；不要把它们一起打包或提交。

## 确认与检索变更（0.7.2）

- `POST /confirm`：单条事务确认，返回 `undo.operationId` 和 scope。
- `POST /confirm/undo`：传 `{ "scope": "private:123", "operationId": "..." }`，完整撤销；冲突返回 HTTP 409。
- `/manage` 的 confirm 只处理同 scope、同 subject_id 的候选，共用事务逻辑。id 前缀按字面匹配，不接受 SQL 通配含义。
- `/stats` 增加版本和 `transactional-confirm` 能力声明。
- `/search` 召回指定聊天及 global 的 active、未过期记忆；返回检索时来源快照 `evidence` 和真实评分因子 `retrieval`。
- `memory_operations` 为追加的本地操作记录表，随确认事务写入；保存状态快照与指纹，不保存新的向量副本。
