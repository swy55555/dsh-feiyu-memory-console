"""本地记忆向量库 + 遗忘曲线服务（给 QQ 里的鱼用）。

设计：
  - 向量：BAAI/bge-small-zh-v1.5（fastembed，ONNX，CPU 即可）
  - 存储：sqlite3（stdlib），向量存 BLOB
  - 遗忘曲线：幂律 R(t) = (1 + t/(9S))^(-1)，S 是"记忆强度"（天），
    查询不强化；本人再次明确表达时有节制强化。核心记忆和待办不自然衰减。
  - 接口：POST /add /search /decay，GET /stats，监听 127.0.0.1:9881

为什么用幂律而不是指数：指数曲线衰减太快（考试前突击那种），
幂律更接近长期记忆的真实行为（FSRS 也是幂律族）。
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import numpy as np

HOME = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("MEMVEC_DB_PATH", os.path.join(HOME, "memories.db"))
PORT = int(os.environ.get("MEMVEC_PORT", "9881"))
MODEL = os.environ.get("MEMVEC_MODEL", "BAAI/bge-small-zh-v1.5")
HALF_LIFE_DAYS = 1.0          # 初始强度（旧默认）
STRENGTH_CAP_DAYS = float(os.environ.get('MEMVEC_STRENGTH_CAP_DAYS', '365'))  # 强度上限
STRENGTH_OWNER_DAYS = float(os.environ.get('MEMVEC_OWNER_STRENGTH_DAYS', '180'))  # 管理员私聊：忘得慢
STRENGTH_OTHER_DAYS = float(os.environ.get('MEMVEC_OTHER_STRENGTH_DAYS', '2'))    # 群聊/非管理员私聊：忘得快
PRUNE_R = 0.12                # 低于这个 Recall 概率就淘汰
MIN_AGE_DAYS = 14.0           # 至少存活 14 天才可能被淘汰

_owner_scope_cache = None
_strength_migrated = False


def owner_scope() -> str:
    """从桥接配置里读 ownerQQ；读不到就返回空串。"""
    global _owner_scope_cache
    if _owner_scope_cache is not None:
        return _owner_scope_cache
    _owner_scope_cache = ''
    try:
        import json
        cfg_path = os.path.join(os.path.expanduser('~'), '.dsh', 'qq-bridge', 'config.json')
        with open(cfg_path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        owner = cfg.get('ownerQQ')
        if owner:
            _owner_scope_cache = f'private:{int(owner)}'
    except Exception:
        pass
    return _owner_scope_cache


def initial_strength(scope: str) -> float:
    owner = owner_scope()
    return STRENGTH_OWNER_DAYS if owner and scope == owner else STRENGTH_OTHER_DAYS

_lock = Lock()
_model = None


def now() -> float:
    return time.time()


def get_model():
    global _model
    if _model is None:
        # 缓存可在 MEMVEC_CACHE_PATH 里改；有缓存才离线，第一次允许联网下载模型。
        cache = os.environ.get("MEMVEC_CACHE_PATH", os.path.join(HOME, "hfcache"))
        os.environ["FASTEMBED_CACHE_PATH"] = cache
        try:
            has_cache = os.path.isdir(cache) and bool(os.listdir(cache))
        except Exception:
            has_cache = False
        if has_cache:
            os.environ["HF_HUB_OFFLINE"] = "1"
        else:
            os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"
        os.environ["no_proxy"] = "localhost,127.0.0.1,::1"
        from fastembed import TextEmbedding
        _model = TextEmbedding(model_name=MODEL)
    return _model


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, factory=ClosingConnection)
    conn.execute("""CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'global',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at REAL NOT NULL,
        last_access REAL NOT NULL,
        strength_days REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        embedding BLOB NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scope ON memories(scope)")
    existing = {r[1] for r in conn.execute('PRAGMA table_info(memories)')}
    for col, definition in {
        'status': "TEXT NOT NULL DEFAULT 'active'", 'fact_key': "TEXT NOT NULL DEFAULT ''",
        'subject_id': "TEXT NOT NULL DEFAULT ''", 'source_id': "TEXT NOT NULL DEFAULT ''",
        'source_text': "TEXT NOT NULL DEFAULT ''", 'source_time': 'REAL NOT NULL DEFAULT 0',
        'confidence': 'REAL NOT NULL DEFAULT 1', 'expires_at': 'REAL NOT NULL DEFAULT 0',
        'superseded_by': "TEXT NOT NULL DEFAULT ''", 'last_reinforced': 'REAL NOT NULL DEFAULT 0',
        'tier': "TEXT NOT NULL DEFAULT 'normal'",
        'relation': "TEXT NOT NULL DEFAULT ''", 'related_id': "TEXT NOT NULL DEFAULT ''",
    }.items():
        if col not in existing:
            conn.execute(f'ALTER TABLE memories ADD COLUMN {col} {definition}')
    # 一次性迁移：旧记忆默认强度 1 天，现在按 scope 分成“忘得慢/忘得快”。
    global _strength_migrated
    if not _strength_migrated:
        _strength_migrated = True
        try:
            owner = owner_scope()
            if owner:
                conn.execute('UPDATE memories SET strength_days=? WHERE strength_days<=1.01 AND scope=?', (STRENGTH_OWNER_DAYS, owner))
                conn.execute('UPDATE memories SET strength_days=? WHERE strength_days<=1.01 AND scope<>?', (STRENGTH_OTHER_DAYS, owner))
            else:
                conn.execute('UPDATE memories SET strength_days=? WHERE strength_days<=1.01', (STRENGTH_OTHER_DAYS,))
            conn.commit()
        except Exception:
            pass
    return conn


def embed(texts: list[str]) -> np.ndarray:
    vecs = [np.asarray(v, dtype=np.float32) for v in get_model().embed(texts)]
    m = np.stack(vecs)
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.maximum(norms, 1e-9)


def recall_prob(strength_days: float, last_access: float, importance: float) -> float:
    # 幂律遗忘：R = (1 + t/(9S))^-1，再按 importance 给一点点保底
    t_days = max(0.0, (now() - last_access) / 86400.0)
    r = 1.0 / (1.0 + t_days / (9.0 * max(strength_days, 0.1)))
    return min(1.0, r + importance * 0.1)


def valid_scope(scope):
    if scope is None or str(scope).strip() == '':
        return 'global'
    import re
    if not isinstance(scope, str) or not re.fullmatch(r'(group|private):[0-9]+', scope):
        raise ValueError('必须提供当前聊天的 group:ID 或 private:ID；旧 global 记忆仅保留归档')
    return scope


def add_memory(text: str, tags: str = "", scope: str = None, importance: float = 0.5, **meta) -> dict:
    scope = valid_scope(scope)
    text = (text or "").strip()
    if not text or len(text) > 500:
        raise ValueError('text 长度必须为 1..500')
    importance = float(importance)
    confidence = float(meta.get('confidence', 1))
    if not 0 <= importance <= 1 or not 0 <= confidence <= 1:
        raise ValueError('importance/confidence 必须为 0..1')
    subject = str(meta.get('subject_id', ''))[:80]
    fact_key = str(meta.get('fact_key', ''))[:100]
    source_id = str(meta.get('source_id', ''))[:120]
    source_text = str(meta.get('source_text', ''))[:1200]
    source_time = float(meta.get('source_time') or now())
    expires = float(meta.get('expires_at') or 0)
    status = 'active' if meta.get('confirmed', False) else 'candidate'
    tier = str(meta.get('tier', 'normal'))
    if tier not in ('normal', 'core', 'task'):
        raise ValueError('invalid tier')
    if tier == 'core':
        expires = 0
    vec = embed([text])[0]
    mid = uuid.uuid4().hex
    ts = now()
    with _lock, db() as conn:
        # Tombstones prevent extraction/reimport from resurrecting deleted evidence.
        semantic = meta.get('semantic_checked') is True
        if not semantic and status == 'active' and fact_key and tier == 'normal':
            old_core = conn.execute("SELECT id FROM memories WHERE scope=? AND subject_id=? AND fact_key=? AND status='active' AND tier='core' AND source_time<=?", (scope, subject, fact_key, source_time)).fetchone()
            if old_core:
                tier, expires = 'core', 0
        prior = conn.execute('SELECT id,status,source_id,source_time FROM memories WHERE scope=? AND subject_id=? AND (text=? OR (source_id<>\'\' AND source_id=? AND fact_key=?)) ORDER BY created_at DESC LIMIT 1',
                             (scope, subject, text, source_id, fact_key)).fetchone()
        if semantic:
            prior = conn.execute('SELECT id,status,source_id,source_time FROM memories WHERE scope=? AND subject_id=? AND text=? ORDER BY created_at DESC LIMIT 1',(scope,subject,text)).fetchone()
        if prior:
            # Only fresh evidence from the same speaker strengthens an active memory.
            if prior[1] == 'active' and status == 'active' and subject and source_id and source_id != prior[2] and source_time > prior[3]:
                conn.execute("UPDATE memories SET last_access=?,last_reinforced=?,strength_days=MIN(?,strength_days*1.4),access_count=access_count+1 WHERE id=? AND last_reinforced<?",
                             (ts, ts, STRENGTH_CAP_DAYS, prior[0], ts-259200))
                if tier == 'core':
                    conn.execute("UPDATE memories SET tier='core',expires_at=0 WHERE id=?", (prior[0],))
                conn.execute('UPDATE memories SET source_id=?,source_time=?,source_text=? WHERE id=?', (source_id, source_time, source_text, prior[0]))
            return {'id': prior[0], 'status': prior[1], 'duplicate': True}
        relation = str(meta.get('relation', 'uncertain')) if semantic else ''
        target_id = str(meta.get('related_id', ''))
        target = None
        if semantic:
            if target_id:
                conn.row_factory = sqlite3.Row
                target = conn.execute("SELECT * FROM memories WHERE id=? AND scope=? AND subject_id=? AND status='active' AND (expires_at=0 OR expires_at>?)", (target_id,scope,subject,ts)).fetchone()
            valid_target = target is not None and target['source_time'] == meta.get('related_time')
            if relation == 'equivalent' and target is not None and source_id and source_id == target['source_id']:
                return {'id':target_id,'status':'active','duplicate':True,'semantic':True}
            if relation in ('equivalent', 'replace') and (not valid_target or float(meta.get('relation_confidence',0)) < .95):
                relation = 'uncertain'
            if relation not in ('independent','equivalent','replace','conflict','uncertain'):
                relation = 'uncertain'
            if relation == 'replace' and float(meta.get('relation_confidence',0)) >= .9 and status == 'candidate':
                status = 'active'  # 明确更正直接生效（群里没有确认界面，尤其需要）
            if relation in ('conflict','uncertain'):
                status = 'candidate'
            if relation == 'equivalent' and status == 'active':
                if source_time > target['source_time'] and source_id != target['source_id']:
                    conn.execute("UPDATE memories SET last_access=?,last_reinforced=?,strength_days=MIN(?,strength_days*1.4),access_count=access_count+1 WHERE id=? AND last_reinforced<?", (ts,ts,STRENGTH_CAP_DAYS,target_id,ts-259200))
                    conn.execute('UPDATE memories SET source_id=?,source_text=?,source_time=? WHERE id=?',(source_id,source_text,source_time,target_id))
                    if tier == 'core':
                        conn.execute("UPDATE memories SET tier='core',expires_at=0 WHERE id=?",(target_id,))
                return {'id':target_id,'status':'active','duplicate':True,'semantic':True}
            if relation == 'replace' and status == 'active':
                if source_time <= target['source_time']:
                    status = 'candidate'
                elif target['tier'] == 'core':
                    tier, expires = 'core', 0
        conn.execute(
            "INSERT INTO memories (id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (mid, text, tags, scope, float(importance), ts, ts, initial_strength(scope), 0, vec.tobytes()),
        )
        conn.execute('UPDATE memories SET status=?,fact_key=?,subject_id=?,source_id=?,source_text=?,source_time=?,confidence=?,expires_at=? WHERE id=?',
                     (status, fact_key, subject, source_id, source_text, source_time, confidence, expires, mid))
        conn.execute('UPDATE memories SET tier=? WHERE id=?', (tier, mid))
        conn.execute('UPDATE memories SET relation=?,related_id=? WHERE id=?',(relation,target_id,mid))
        if semantic and relation == 'replace' and status == 'active':
            conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?",(mid,target_id))
        if not semantic and status == 'active' and fact_key:
            newer = conn.execute("SELECT id FROM memories WHERE scope=? AND subject_id=? AND fact_key=? AND status='active' AND source_time>? AND id<>? LIMIT 1", (scope, subject, fact_key, source_time, mid)).fetchone()
            if newer:
                conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?", (newer[0], mid))
                status = 'superseded'
            else:
                conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE scope=? AND subject_id=? AND fact_key=? AND status='active' AND id<>?", (mid, scope, subject, fact_key, mid))
    return {"id": mid, "text": text, "scope": scope, "importance": importance, 'status': status}


def search_memory(query: str, k: int = 5, scope: str | None = None, min_score: float = 0.35) -> list[dict]:
    scope = valid_scope(scope)
    if not isinstance(query, str) or not query.strip() or len(query) > 2000:
        return []
    k = max(1, min(20, int(k)))
    q = embed([query])[0]
    with _lock, db() as conn:
        rows = conn.execute(
            "SELECT id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,tier FROM memories"
            + " WHERE (scope=? OR scope='global') AND status='active' AND (expires_at=0 OR expires_at>?)",
            (scope, now()),
        ).fetchall()
        if not rows:
            return []
        mat = np.stack([np.frombuffer(r[9], dtype=np.float32) for r in rows])
        sims = mat @ q
        scored = []
        for r, sim in zip(rows, sims):
            rp = 1.0 if r[10] != 'normal' else recall_prob(r[7], r[6], r[4])
            # 相似度为主，遗忘曲线做加成/惩罚
            score = float(sim) * (0.65 + 0.35 * rp)
            scored.append((score, rp, float(sim), r))
        scored.sort(key=lambda x: -x[0])
        out = []
        for score, rp, sim, r in scored[:k]:
            if score < min_score:
                continue
            out.append({
                "id": r[0], "text": r[1], "tags": r[2], "scope": r[3],
                "importance": r[4], "sim": round(sim, 4), "score": round(score, 4),
                "recall": round(rp, 3), "access_count": r[8],
                'created_at': r[5],
            })
        # Search is read-only. Explicit adoption is acknowledged separately.
        return out


def reinforce(scope, ids):
    scope = valid_scope(scope)
    changed = 0
    with _lock, db() as conn:
        for mid in list(dict.fromkeys(ids))[:20]:
            changed += conn.execute("UPDATE memories SET last_access=?,last_reinforced=?,strength_days=MIN(?,strength_days*1.4),access_count=access_count+1 WHERE id=? AND scope=? AND status='active' AND last_reinforced<? AND (expires_at=0 OR expires_at>?)",
                (now(), now(), STRENGTH_CAP_DAYS, mid, scope, now()-259200, now())).rowcount
    return {'changed': changed}


def related_memories(scope, subject_id, query):
    scope = valid_scope(scope)
    if not str(subject_id or '').isdigit() or not isinstance(query,str) or not query.strip():
        return []
    q = embed([query[:2000]])[0]
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT id,text,source_time,subject_id,tier,embedding FROM memories WHERE scope=? AND subject_id=? AND status='active' AND (expires_at=0 OR expires_at>?)",(scope,str(subject_id),now())).fetchall()
    scored = sorted(((float(np.frombuffer(r['embedding'],dtype=np.float32) @ q), r) for r in rows),key=lambda x:-x[0])
    return [{k:r[k] for k in ('id','text','source_time','subject_id','tier')} for score,r in scored[:8] if score >= .35]


def priority_memories(scope, subject_id):
    scope = valid_scope(scope)
    # Core context belongs to the current human, not all members of a group.
    if not str(subject_id or '').isdigit():
        return []
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT id,text,created_at,tier FROM memories WHERE scope=? AND subject_id=? AND status='active' AND tier IN ('core','task') AND (expires_at=0 OR expires_at>?) ORDER BY CASE tier WHEN 'core' THEN 0 ELSE 1 END,source_time DESC LIMIT 8", (scope, str(subject_id), now())).fetchall()
    return [{**dict(r), 'score': 1.0} for r in rows]


def finish_memory(scope, mid):
    scope = valid_scope(scope)
    with _lock, db() as conn:
        changed = conn.execute("UPDATE memories SET status='completed' WHERE id=? AND scope=? AND tier='task' AND status='active'", (mid, scope)).rowcount
    return {'changed': changed}


def manage_memory(scope, subject_id, action, query='', replacement='', source_id=''):
    """Human-command endpoint: every read/write is scoped to its actual sender."""
    scope = valid_scope(scope)
    subject_id = str(subject_id or '')
    if not subject_id.isdigit() or action not in ('list', 'remove', 'correct', 'finish', 'confirm'):
        raise ValueError('invalid memory command')
    query, replacement = str(query).strip(), str(replacement).strip()
    if action not in ('list', 'confirm') and (len(query) < 2 or query in ('这个', '这件事', '它', '那个', '全部', '所有')):
        return {'changed': 0, 'need_query': True, 'memories': []}
    if action == 'correct' and not 4 <= len(replacement) <= 300:
        raise ValueError('纠正内容应为 4..300 字符的完整事实')
    # 2026-10-26：确认候选记忆。query 为空 = 确认当前 scope 下全部候选。
    if action == 'confirm':
        with _lock, db() as conn:
            if query:
                rows = conn.execute(
                    "SELECT id FROM memories WHERE scope=? AND status='candidate' AND id LIKE ?",
                    (scope, query + '%'),
                ).fetchall()
                ids = [r[0] for r in rows]
            else:
                rows = conn.execute(
                    "SELECT id FROM memories WHERE scope=? AND status='candidate'", (scope,)
                ).fetchall()
                ids = [r[0] for r in rows]
            if not ids:
                return {'changed': 0, 'memories': [], 'total': 0}
            conn.executemany("UPDATE memories SET status='active' WHERE id=?", [(i,) for i in ids])
        return {'changed': len(ids), 'confirmed': len(ids)}

    new_text = f'用户（QQ {subject_id}）曾说：{replacement}'
    vec = embed([new_text])[0] if action == 'correct' else None
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM memories WHERE scope=? AND subject_id=? AND status IN ('active','candidate') ORDER BY created_at DESC", (scope, subject_id)).fetchall()
        if action == 'finish':
            rows = [r for r in rows if r['tier'] == 'task' and r['status'] == 'active']
        if query:
            rows = [r for r in rows if (len(query) >= 8 and r['id'].startswith(query)) or query in r['text'].split('曾说：', 1)[-1]]
        public = lambda r: {k: r[k] for k in ('id', 'text', 'tier', 'status', 'relation', 'related_id')}
        if action == 'list' or len(rows) != 1:
            return {'changed': 0, 'memories': [public(r) for r in rows[:20]], 'total': len(rows)}
        old = rows[0]
        if action == 'correct':
            mid, ts = uuid.uuid4().hex, now()
            conn.execute("INSERT INTO memories (id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,status,fact_key,subject_id,source_id,source_text,source_time,confidence,expires_at,tier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (mid,new_text,old['tags'],scope,old['importance'],ts,ts,HALF_LIFE_DAYS,0,vec.tobytes(),'active',old['fact_key'],subject_id,str(source_id)[:120],replacement,ts,1,old['expires_at'],old['tier']))
            conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?", (mid,old['id']))
            if old['status'] == 'candidate' and old['related_id']:
                conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=? AND scope=? AND subject_id=? AND status='active'",(mid,old['related_id'],scope,subject_id))
        else:
            mid = old['id']
            conn.execute('UPDATE memories SET status=? WHERE id=?', ('deleted' if action == 'remove' else 'completed', mid))
        return {'changed': 1, 'id': mid, 'text': replacement if action == 'correct' else old['text']}


def remove_memory(scope, mid):
    scope = valid_scope(scope)
    with _lock, db() as conn:
        changed = conn.execute("UPDATE memories SET status='deleted' WHERE id=? AND scope=?", (mid, scope)).rowcount
    return {'changed': changed}


def list_memories(scope, status='active'):
    scope = valid_scope(scope)
    if status not in ('active', 'candidate', 'superseded', 'deleted', 'archived', 'completed'):
        raise ValueError('invalid status')
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute('SELECT id,text,status,tier,fact_key,subject_id,source_id,source_text,source_time,confidence,expires_at,relation,related_id FROM memories WHERE scope=? AND status=? ORDER BY created_at DESC LIMIT 200', (scope, status)).fetchall()
    return [dict(r) for r in rows]


def confirm_memory(scope, mid):
    scope = valid_scope(scope)
    with _lock, db() as conn:
        row = conn.execute("SELECT subject_id,fact_key,source_time,relation,related_id FROM memories WHERE id=? AND scope=? AND status='candidate'", (mid, scope)).fetchone()
        if not row:
            return {'changed': 0}
        if row[3]:
            if row[4]:
                target = conn.execute("SELECT source_time,tier FROM memories WHERE id=? AND scope=? AND subject_id=? AND status='active'",(row[4],scope,row[0])).fetchone()
                if not target or target[0] > row[2]:
                    raise ValueError('关联记忆已更新，请通过纠正命令明确新事实')
                if target[1] == 'core':
                    conn.execute("UPDATE memories SET tier='core',expires_at=0 WHERE id=?",(mid,))
                conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?",(mid,row[4]))
        elif row[1]:
            newer = conn.execute("SELECT id FROM memories WHERE scope=? AND subject_id=? AND fact_key=? AND status='active' AND source_time>?", (scope, *row[:3])).fetchone()
            if newer:
                raise ValueError('已有更新的已确认事实，请先处理冲突')
            conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE scope=? AND subject_id=? AND fact_key=? AND status='active'", (mid, scope, row[0], row[1]))
        conn.execute("UPDATE memories SET status='active' WHERE id=?", (mid,))
    return {'changed': 1}


def decay(prune: bool = True) -> dict:
    removed = 0
    total = 0
    with _lock, db() as conn:
        rows = conn.execute("SELECT id,last_access,strength_days,importance FROM memories WHERE status='active' AND tier='normal'").fetchall()
        total = len(rows)
        for mid, last, strength, importance in rows:
            rp = recall_prob(strength, last, importance)
            age = (now() - last) / 86400.0
            if prune and rp < PRUNE_R and age > MIN_AGE_DAYS and importance < 0.8:
                conn.execute("UPDATE memories SET status='archived' WHERE id=?", (mid,))
                removed += 1
    return {"total": total, "removed": removed, "prune_r": PRUNE_R}


def stats() -> dict:
    with _lock, db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        scopes = conn.execute("SELECT scope, COUNT(*) FROM memories GROUP BY scope").fetchall()
        avg = conn.execute("SELECT AVG(strength_days), AVG(importance) FROM memories").fetchone()
    return {
        "total": total,
        "scopes": {s: c for s, c in scopes},
        "avg_strength_days": round(avg[0] or 0, 2),
        "avg_importance": round(avg[1] or 0, 3),
        "db": DB_PATH,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静点
        pass

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("content-length") or 0)
        if n > 65536:
            raise ValueError('request too large')
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/stats"):
            self._send(200, {"ok": True, "stats": stats()})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            if self.path == "/add":
                b = self._body()
                r = add_memory(**b)
                self._send(200, {"ok": True, "memory": r})
            elif self.path == "/search":
                b = self._body()
                r = search_memory(b.get("query", ""), int(b.get("k", 5)), b.get("scope"), float(b.get('min_score', 0.35)))
                self._send(200, {"ok": True, "results": r})
            elif self.path == '/reinforce':
                b = self._body()
                self._send(200, {'ok': True, **reinforce(b.get('scope'), b.get('ids', []))})
            elif self.path == '/priority':
                b = self._body()
                self._send(200, {'ok': True, 'results': priority_memories(b.get('scope'), b.get('subject_id'))})
            elif self.path == '/manage':
                self._send(200, {'ok': True, **manage_memory(**self._body())})
            elif self.path == '/related':
                self._send(200, {'ok': True, 'results': related_memories(**self._body())})
            elif self.path == '/finish':
                b = self._body()
                self._send(200, {'ok': True, **finish_memory(b.get('scope'), b.get('id'))})
            elif self.path == '/remove':
                b = self._body()
                self._send(200, {'ok': True, **remove_memory(b.get('scope'), b.get('id'))})
            elif self.path == '/list':
                b = self._body()
                self._send(200, {'ok': True, 'memories': list_memories(b.get('scope'), b.get('status', 'active'))})
            elif self.path == '/confirm':
                b = self._body()
                self._send(200, {'ok': True, **confirm_memory(b.get('scope'), b.get('id'))})
            elif self.path.startswith("/decay"):
                b = self._body()
                self._send(200, {"ok": True, "result": decay(bool(b.get("prune", True)))})
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})


def main():
    get_model()  # 先把模型加载好，避免第一个请求超时
    conn = db()
    conn.close()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"memvec listening on 127.0.0.1:{PORT}, db={DB_PATH}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
