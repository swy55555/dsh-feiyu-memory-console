# memvec（随插件附带的源码）

本地记忆向量库 + 遗忘曲线服务。给「大肥鱼的记忆」提供 `127.0.0.1:9881`。

这里只放**源码**，不包含：

- `memories.db`（你的聊天记忆）
- `hfcache/`（约 90MB 的 embedding 模型）
- 日志
- 任何本地启动快捷方式或绝对路径

## 依赖

- Python 3.10+
- `pip install -r requirements.txt`

首次启动会下载 `BAAI/bge-small-zh-v1.5`（约 90MB）到 `hfcache/`，之后离线加载。也可以把已有的 `hfcache/` 放到本目录，或设置 `MEMVEC_CACHE_PATH` 指向它。

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
