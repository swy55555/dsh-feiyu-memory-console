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
import hashlib
import math
import os
import re
import sqlite3
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread

# 后台常驻服务别一次抽走所有核：embedding 是主要 CPU 来源。
# 默认 4 线程；单机想更快可设 MEMVEC_THREADS=8，想更省设 2。
EMBED_THREADS = int(os.environ.get("MEMVEC_THREADS", "4") or 0)
if EMBED_THREADS > 0:
    for _k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(_k, str(EMBED_THREADS))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np

HOME = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("MEMVEC_DB_PATH", os.path.join(HOME, "memories.db"))
PORT = int(os.environ.get("MEMVEC_PORT", "9881"))
MODEL = os.environ.get("MEMVEC_MODEL", "BAAI/bge-small-zh-v1.5")
HALF_LIFE_DAYS = 1.0          # 初始强度（旧默认）
STRENGTH_CAP_DAYS = float(os.environ.get('MEMVEC_STRENGTH_CAP_DAYS', '365'))  # 强度上限
STRENGTH_OWNER_DAYS = float(os.environ.get('MEMVEC_OWNER_STRENGTH_DAYS', '180'))  # 管理员私聊：忘得慢
STRENGTH_OTHER_DAYS = float(os.environ.get('MEMVEC_OTHER_STRENGTH_DAYS', '2'))    # 群聊/非管理员私聊：忘得快
ANN_MIN = int(os.environ.get('MEMVEC_ANN_MIN', '20000'))  # 超过这个量才考虑 ANN\nPRUNE_R = 0.12                # 低于这个 Recall 概率就淘汰
MIN_AGE_DAYS = 14.0           # 至少存活 14 天才可能被淘汰

_owner_scope_cache = None
_strength_migrated = False
_matrix_cache = {}
_MATRIX_CACHE_TTL = 30.0


def _matrix_cache_clear():
    _matrix_cache.clear()


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
        _model = TextEmbedding(model_name=MODEL, threads=EMBED_THREADS or None)
    return _model


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
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
    # 原文层：逐条消息，独立于桥接的 recentMessages/DSH 会话历史。
    # 主键用 key + messageId（messageId 缺失时退回时间戳），保证重投不重复。
    conn.execute("""CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        message_id TEXT NOT NULL DEFAULT '',
        sender TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        at REAL NOT NULL,
        is_self INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT ''
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_key_at ON messages(key, at)")
    # 摘要层：会话摘要，P0 只建表，P1 由桥接写入。
    conn.execute("""CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        period_start REAL NOT NULL DEFAULT 0,
        period_end REAL NOT NULL DEFAULT 0,
        covered_ids TEXT NOT NULL DEFAULT '[]',
        text TEXT NOT NULL DEFAULT '',
        structured TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        error_note TEXT NOT NULL DEFAULT ''
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_summaries_key ON session_summaries(key, period_end)")
    summary_cols = {r[1] for r in conn.execute('PRAGMA table_info(session_summaries)')}
    for col, definition in {
        'value': 'REAL NOT NULL DEFAULT 1',
        'kind': "TEXT NOT NULL DEFAULT 'summary'",
    }.items():
        if col not in summary_cols:
            conn.execute(f'ALTER TABLE session_summaries ADD COLUMN {col} {definition}')
    conn.execute("""CREATE TABLE IF NOT EXISTS memory_operations (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at REAL NOT NULL,
        changes TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS memory_review_pages (
        scope TEXT NOT NULL, memory_id TEXT NOT NULL, operation TEXT NOT NULL,
        revision TEXT NOT NULL, page_offset INTEGER NOT NULL, review TEXT NOT NULL,
        created_at REAL NOT NULL,
        PRIMARY KEY(scope,memory_id,operation,revision,page_offset)
    )""")
    existing = {r[1] for r in conn.execute('PRAGMA table_info(memories)')}
    for col, definition in {
        'status': "TEXT NOT NULL DEFAULT 'active'", 'fact_key': "TEXT NOT NULL DEFAULT ''",
        'subject_id': "TEXT NOT NULL DEFAULT ''", 'source_id': "TEXT NOT NULL DEFAULT ''",
        'source_text': "TEXT NOT NULL DEFAULT ''", 'source_time': 'REAL NOT NULL DEFAULT 0',
        'confidence': 'REAL NOT NULL DEFAULT 1', 'expires_at': 'REAL NOT NULL DEFAULT 0',
        'superseded_by': "TEXT NOT NULL DEFAULT ''", 'last_reinforced': 'REAL NOT NULL DEFAULT 0',
        'tier': "TEXT NOT NULL DEFAULT 'normal'",
        'relation': "TEXT NOT NULL DEFAULT ''", 'related_id': "TEXT NOT NULL DEFAULT ''",
        'fact_meta': "TEXT NOT NULL DEFAULT '{}'",
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


def fact_quote(text):
    return str(text or '').split('曾说：', 1)[-1].strip()


def validated_fact(proposal, text):
    # Labels are semantic model output, not a fixed keyword taxonomy. Whole-quote
    # evidence prevents dropping a negation/condition when selecting a short span.
    if not isinstance(proposal, dict) or proposal.get('evidence') != fact_quote(text):
        return {}
    fields = {key: proposal.get(key) for key in ('object', 'attribute', 'value', 'condition', 'timeframe')}
    if any(not isinstance(v, str) or len(v) > 100 for v in fields.values()):
        return {}
    if not all(fields[k].strip() for k in ('object', 'attribute', 'value')):
        return {}
    if proposal.get('cardinality') not in ('single', 'multi', 'unknown'):
        return {}
    return {**fields, 'evidence': proposal['evidence'], 'cardinality': proposal['cardinality'], 'source': 'model'}


def stored_fact(row):
    row = dict(row)
    try:
        proposal = json.loads(row.get('fact_meta') or '{}')
    except (ValueError, TypeError):
        return {}
    return validated_fact(proposal, row.get('text'))


def fact_relation(a, b):
    a, b = dict(a), dict(b)
    if a.get('scope') != b.get('scope') or a.get('subject_id') != b.get('subject_id'):
        return 'coexist'
    left, right = stored_fact(a), stored_fact(b)
    if not left or not right:
        return 'uncertain'
    if left['object'] != right['object'] or left['attribute'] != right['attribute']:
        return 'uncertain'  # Labels can be aliases or overlapping categories.
    if left['condition'] != right['condition'] or left['timeframe'] != right['timeframe']:
        return 'uncertain'  # Overlap requires semantic review, never a word-list guess.
    if left['value'] == right['value']:
        return 'equivalent'
    return 'conflict' if left['cardinality'] == right['cardinality'] == 'single' else 'uncertain'


def _review_context(conn, candidate, offset=0, all_rows=False):
    rows = conn.execute("SELECT * FROM memories WHERE scope=? AND subject_id=? AND status='active' AND id<>? AND (expires_at=0 OR expires_at>?) ORDER BY id",
                        (candidate['scope'], candidate['subject_id'], candidate['id'], now())).fetchall()
    q = np.frombuffer(candidate['embedding'], dtype=np.float32)
    def similarity(row):
        v = np.frombuffer(row['embedding'], dtype=np.float32)
        return float(v @ q) if v.shape == q.shape else -1.0
    ranked = sorted(rows, key=similarity, reverse=True)
    # Explicit links are kept, then fill by semantic similarity; no lexical gate.
    selected = [r for r in rows if r['id'] == candidate['related_id']]
    selected += [r for r in ranked if r not in selected]
    total = len(selected)
    selected = selected if all_rows else selected[offset:offset+8]
    revision = hashlib.sha256(json.dumps([_review_fingerprint(candidate), *[_review_fingerprint(r) for r in rows]]).encode()).hexdigest()
    def public(row):
        return {**{k: row[k] for k in ('id','text','source_time','tier')}, 'quote': fact_quote(row['text']), 'fact': stored_fact(row)}
    return {'scope': candidate['scope'], 'candidate': public(candidate), 'related': [public(r) for r in selected],
            'revision': revision, 'truncated': total > offset+len(selected),
            'offset': offset, 'total': total}, selected


def _cached_reviews(conn, candidate, operation):
    context, rows = _review_context(conn, candidate, all_rows=True)
    relations = {}
    cached = {r['page_offset']: r['review'] for r in conn.execute(
        'SELECT page_offset,review FROM memory_review_pages WHERE scope=? AND memory_id=? AND operation=? AND revision=?',
        (candidate['scope'], candidate['id'], operation, context['revision']))}
    next_offset = None
    for offset in range(0, len(rows), 8):
        page = {**context, 'related': context['related'][offset:offset+8]}
        try:
            verdict = _validated_review(json.loads(cached.get(offset, 'null')), page)
        except (ValueError, TypeError):
            verdict = None
        if verdict is not None:
            relations.update(verdict)
        elif next_offset is None:
            next_offset = offset
    return context, rows, relations, next_offset


def confirmation_context(scope, mid, operation='confirm'):
    scope = valid_scope(scope)
    statuses = _activation_statuses(operation)
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        candidate = conn.execute("SELECT * FROM memories WHERE scope=? AND id=? AND status IN (" + ','.join('?' for _ in statuses) + ')', (scope, mid, *statuses)).fetchone()
        if candidate is None:
            return {'needed': False}
        full, _, relations, offset = _cached_reviews(conn, candidate, operation)
        context, _ = _review_context(conn, candidate, offset or 0)
        return {'needed': offset is not None, 'context': context,
                'reviewed': len(relations), 'total': full['total']}


def save_review_page(scope, mid, operation, offset, review):
    scope = valid_scope(scope)
    statuses = _activation_statuses(operation)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset % 8:
        raise ValueError('invalid review offset')
    with _lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.row_factory = sqlite3.Row
        candidate = conn.execute("SELECT * FROM memories WHERE scope=? AND id=? AND status IN (" + ','.join('?' for _ in statuses) + ')', (scope, mid, *statuses)).fetchone()
        if candidate is None:
            raise MemoryConflict('记忆状态已变化，请重新开始复核')
        context, rows = _review_context(conn, candidate, offset)
        if not rows or _validated_review(review, context) is None:
            raise MemoryConflict('复核版本已变化或该批证据不完整；已有事实未改变')
        conn.execute('DELETE FROM memory_review_pages WHERE scope=? AND memory_id=? AND operation=? AND revision<>?',
                     (scope, mid, operation, context['revision']))
        conn.execute('INSERT OR REPLACE INTO memory_review_pages VALUES (?,?,?,?,?,?,?)',
                     (scope, mid, operation, context['revision'], offset, json.dumps(review, ensure_ascii=False), now()))
        full, _, relations, missing = _cached_reviews(conn, candidate, operation)
        return {'pending': missing is not None, 'reviewed': len(relations), 'total': full['total']}


def _validated_review(review, context):
    if not isinstance(review, dict) or review.get('revision') != context['revision']:
        return None
    if review.get('candidateEvidence') != context['candidate']['quote'] or not isinstance(review.get('relations'), list):
        return None
    known = {r['id']: r for r in context['related']}
    relations = {}
    for item in review['relations']:
        if not isinstance(item, dict) or item.get('id') not in known or item['id'] in relations:
            return None
        confidence = item.get('confidence')
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            return None
        if item.get('evidence') != known[item['id']]['quote'] or item.get('relation') not in ('equivalent','supplement','coexist','replace','conflict','uncertain'):
            return None
        relations[item['id']] = item['relation'] if confidence >= .9 else 'uncertain'
    return relations if set(relations) == set(known) else None


def _fact_peers(conn, row):
    return [r for r in conn.execute("SELECT * FROM memories WHERE scope=? AND subject_id=? AND status='active' AND id<>? AND (expires_at=0 OR expires_at>?)",
                                    (row['scope'], row['subject_id'], row['id'], now()))
            if fact_relation(row, r) in ('conflict', 'equivalent')]


def add_memory(text: str, tags: str = "", scope: str = None, importance: float = 0.5, **meta) -> dict:
    _matrix_cache_clear()
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
        conn.row_factory = sqlite3.Row
        incoming = {'id': mid, 'text': text, 'scope': scope, 'subject_id': subject, 'fact_meta': json.dumps(validated_fact(meta.get('fact'), text), ensure_ascii=False)}
        prior = conn.execute('SELECT id,status,source_id,source_time FROM memories WHERE scope=? AND subject_id=? AND text=? ORDER BY created_at DESC LIMIT 1',
                             (scope, subject, text)).fetchone()
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
        # 重复事件（同正文、不同日期）先尝试合并，避免“每天去广场”堆成 20 条。
        if status == 'active' and not semantic:
            merged = _try_merge_dated(conn, scope, subject, text, importance, tier,
                                      source_id, source_text, source_time, ts)
            if merged:
                return merged
        relation = str(meta.get('relation', 'uncertain')) if semantic else ''
        target_id = str(meta.get('related_id', ''))
        target = None
        if semantic:
            if target_id:
                conn.row_factory = sqlite3.Row
                target = conn.execute("SELECT * FROM memories WHERE id=? AND scope=? AND subject_id=? AND status='active' AND (expires_at=0 OR expires_at>?)", (target_id,scope,subject,ts)).fetchone()
            valid_target = target is not None and target['source_time'] == meta.get('related_time')
            if target is not None:
                comparison_target = dict(target)
                if meta.get('related_fact'):
                    comparison_target['fact_meta'] = json.dumps(validated_fact(meta.get('related_fact'), target['text']), ensure_ascii=False)
                verified_relation = fact_relation(incoming, comparison_target)
                if verified_relation == 'coexist':
                    relation, target_id, target = 'independent', '', None
                elif verified_relation == 'uncertain':
                    relation = 'uncertain'
                elif relation == 'equivalent' and verified_relation != 'equivalent':
                    relation = 'conflict'
                elif relation == 'replace' and (meta.get('explicit_update') is not True or meta.get('update_evidence') != fact_quote(text)):
                    relation = 'conflict'
            if relation == 'equivalent' and target is not None and source_id and source_id == target['source_id']:
                return {'id':target_id,'status':'active','duplicate':True,'semantic':True}
            if relation in ('equivalent', 'replace') and (not valid_target or float(meta.get('relation_confidence',0)) < .95):
                relation = 'uncertain'
            if relation not in ('independent','equivalent','replace','conflict','uncertain'):
                relation = 'uncertain'
            # Extracted corrections require reviewed/manual activation, even at high confidence.
            if relation in ('replace','conflict','uncertain'):
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
        # A fresh timestamp or a shared topic never authorizes overwriting facts.
        if status == 'active' and relation != 'replace' and any(fact_relation(incoming, r) == 'conflict' for r in _fact_peers(conn, incoming)):
            status = 'candidate'
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
        conn.execute('UPDATE memories SET fact_meta=? WHERE id=?', (incoming['fact_meta'], mid))
    return {"id": mid, "text": text, "scope": scope, "importance": importance, 'status': status}


# 重复事件合并：把“10月1日，去广场玩了”和“10月2日，去广场玩了”压成一条。
DATE_RE = re.compile(r'(?:(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?|(\d{1,2})\s*月\s*(\d{1,2})\s*日)')
MERGE_STRIP = re.compile(r'^[\s，,。；;：:、\-—]+|[\s，,。；;：:、\-—]+$')
MERGE_NORM = re.compile(r'[\s，,。！？!?；;：:、（）()“”"\'·…]+')


def _parse_event(text: str):
    """返回 (日期列表, 去掉日期后的正文, 归一化正文)；没有日期返回 None。"""
    dates = []
    for m in DATE_RE.finditer(text or ''):
        if m.group(1):
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        else:
            y, mo, d = None, int(m.group(4)), int(m.group(5))
        if 1 <= mo <= 12 and 1 <= d <= 31:
            dates.append((y, mo, d))
    if not dates:
        return None
    rest = DATE_RE.sub('', text or '')
    rest = MERGE_STRIP.sub('', rest).strip()
    norm = MERGE_NORM.sub('', rest)
    return dates, rest, norm


def _format_dates(dates) -> str:
    if not dates:
        return ''
    first_year = next((y for y, _, _ in dates if y), None)
    norm = [((y if y else first_year), mo, d) for y, mo, d in dates]
    uniq = sorted(set(norm), key=lambda x: (x[0] or 0, x[1], x[2]))
    same_year = first_year is not None and all(y == first_year for y, _, _ in uniq)
    out = []
    for i, (y, mo, d) in enumerate(uniq):
        if y and (i == 0 or not same_year or y != first_year):
            out.append(f'{y}年{mo}月{d}日')
        else:
            out.append(f'{mo}月{d}日')
    return '、'.join(out)


def _merge_dated_text(a: str, b: str):
    """只有“正文相同、日期不同”的两个事件才合并；返回合并后的正文或 None。"""
    pa, pb = _parse_event(a), _parse_event(b)
    if not pa or not pb:
        return None
    if not pa[2] or pa[2] != pb[2]:
        return None
    if set(pa[0]) == set(pb[0]):
        return None
    body = pa[1] if len(pa[1]) >= len(pb[1]) else pb[1]
    merged = _format_dates(list(set(pa[0]) | set(pb[0])))
    return f'{merged}，{body}' if body else merged


def _try_merge_dated(conn, scope, subject, text, importance, tier, source_id, source_text, source_time, ts):
    """写入时做一次邻近合并；命中返回合并后的记录，否则 None。"""
    parsed = _parse_event(text)
    if not parsed or not parsed[2]:
        return None
    rows = conn.execute(
        "SELECT id,text,importance,strength_days,tier,source_text,source_time,created_at"
        " FROM memories WHERE scope=? AND subject_id=? AND status='active' ORDER BY created_at ASC LIMIT 500",
        (scope, subject),
    ).fetchall()
    for row in rows:
        merged_text = _merge_dated_text(row[1], text)
        if not merged_text:
            continue
        vec = embed([merged_text])[0]
        new_tier = 'core' if (tier == 'core' or row[4] == 'core') else row[4]
        new_imp = max(float(importance), float(row[2] or 0))
        new_strength = min(STRENGTH_CAP_DAYS, max(float(row[3] or 0), float(initial_strength(scope))) * 1.1)
        old_source = str(row[5] or '')
        combined_source = (old_source + '\n' + (source_text or '')).strip()[-1200:]
        conn.execute(
            "UPDATE memories SET text=?,embedding=?,importance=?,strength_days=?,last_access=?,"
            "access_count=access_count+1,tier=?,expires_at=CASE WHEN ?='core' THEN 0 ELSE expires_at END,"
            "source_id=?,source_text=?,source_time=MAX(source_time,?) WHERE id=?",
            (merged_text, vec.tobytes(), new_imp, new_strength, ts, new_tier, new_tier,
             source_id or '', combined_source, source_time, row[0]),
        )
        return {'id': row[0], 'text': merged_text, 'scope': scope, 'status': 'active', 'merged': True, 'duplicate': True}
    return None


def consolidate_scope(scope: str, dry: bool = False) -> dict:
    _matrix_cache_clear()
    """把一个聊天里“正文相同、只有日期不同”的记忆合并成一条。"""
    scope = valid_scope(scope)
    groups = {}
    with _lock, db() as conn:
        rows = conn.execute(
            "SELECT id,text,importance,strength_days,tier,created_at,subject_id,source_text FROM memories"
            " WHERE scope=? AND status='active' ORDER BY created_at ASC LIMIT 2000",
            (scope,),
        ).fetchall()
        for row in rows:
            parsed = _parse_event(row[1])
            if not parsed or not parsed[2]:
                continue
            key = (str(row[6] or ''), parsed[2])
            groups.setdefault(key, []).append({
                'id': row[0], 'dates': parsed[0], 'body': parsed[1],
                'importance': float(row[2] or 0), 'strength': float(row[3] or 0),
                'tier': row[4] or 'normal', 'subject': row[6] or '',
            })
        merged = 0
        for items in groups.values():
            if len(items) < 2:
                continue
            items.sort(key=lambda x: x['body'])
            target = items[0]
            dates = set()
            for it in items:
                dates |= set(it['dates'])
            body = max((it['body'] for it in items), key=len)
            text = _format_dates(list(dates))
            if body:
                text = f'{text}，{body}' if text else body
            if dry:
                merged += len(items) - 1
                continue
            vec = embed([text])[0]
            best_imp = max(it['importance'] for it in items)
            best_strength = min(STRENGTH_CAP_DAYS, max(it['strength'] for it in items) * 1.1)
            best_tier = 'core' if any(it['tier'] == 'core' for it in items) else ('task' if any(it['tier'] == 'task' for it in items) else 'normal')
            conn.execute(
                "UPDATE memories SET text=?,embedding=?,importance=?,strength_days=?,tier=?,"
                "expires_at=CASE WHEN ?='core' THEN 0 ELSE expires_at END WHERE id=?",
                (text, vec.tobytes(), best_imp, best_strength, best_tier, best_tier, target['id']),
            )
            for it in items:
                if it['id'] == target['id']:
                    continue
                conn.execute(
                    "UPDATE memories SET status='superseded',relation='merge',superseded_by=? WHERE id=?",
                    (target['id'], it['id']),
                )
                merged += 1
    return {'scope': scope, 'merged': merged, 'groups': len(groups)}


def consolidate_all(dry: bool = False) -> dict:
    with _lock, db() as conn:
        scopes = [r[0] for r in conn.execute("SELECT DISTINCT scope FROM memories WHERE status='active'").fetchall()
                  if not str(r[0]).startswith('global')]
    total = 0
    details = []
    for scope in scopes:
        try:
            result = consolidate_scope(scope, dry=dry)
            total += result['merged']
            details.append(result)
        except Exception as exc:  # 单条失败不影响其他聊天
            details.append({'scope': scope, 'error': str(exc)})
    return {'ok': True, 'merged': total, 'scopes': details}


def _consolidate_loop():
    time.sleep(8)
    while True:
        try:
            result = consolidate_all()
            if result.get('merged'):
                print(f'[memvec] 合并重复事件 {result["merged"]} 条', flush=True)
        except Exception as exc:
            print(f'[memvec] 合并失败: {exc}', flush=True)
        time.sleep(6 * 3600)


def add_message(key: str, message_id: str = '', sender: str = '', user_id: str = '',
                text: str = '', at: float | None = None, is_self: bool = False, meta: str = '') -> dict:
    """原文层写入。幂等：同一 key+messageId 重复投递只保留一条。"""
    key = valid_scope(key)
    text = (text or '').strip()
    if not text or len(text) > 2000:
        raise ValueError('text 长度必须为 1..2000')
    ts = float(at) if at else now() * 1000
    mid = f'{key}:{message_id}' if message_id else f'{key}:{int(ts)}:{uuid.uuid4().hex[:8]}'
    with _lock, db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO messages (id,key,message_id,sender,user_id,text,at,is_self,meta) VALUES (?,?,?,?,?,?,?,?,?)',
            (mid, key, str(message_id or ''), str(sender or ''), str(user_id or ''), text, ts, 1 if is_self else 0, str(meta or '')))
        # 每个聊天保留最近 5000 条；原文不参与遗忘曲线，只按条数淘汰。
        conn.execute('DELETE FROM messages WHERE key=? AND id NOT IN (SELECT id FROM messages WHERE key=? ORDER BY at DESC LIMIT 5000)', (key, key))
    return {'id': mid}


def context_messages(key: str, limit: int = 200, budget_chars: int = 8000,
                     before_at: float | None = None, after_at: float | None = None) -> list[dict]:
    """原文层读取：从最新往前装到字符预算，再按时间升序返回。"""
    key = valid_scope(key)
    limit = max(1, min(1000, int(limit)))
    budget_chars = max(500, min(40000, int(budget_chars)))
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        sql = 'SELECT id,message_id,sender,user_id,text,at,is_self FROM messages WHERE key=?'
        args = [key]
        if before_at:
            sql += ' AND at < ?'
            args.append(float(before_at))
        if after_at:
            sql += ' AND at > ?'
            args.append(float(after_at))
        sql += ' ORDER BY at DESC LIMIT ?'
        args.append(limit)
        rows = conn.execute(sql, args).fetchall()
    picked, used = [], 0
    for r in rows:
        line = f"{r['sender'] or '某人'}：{r['text']}"
        if used + len(line) + 1 > budget_chars:
            break
        picked.append(dict(r))
        used += len(line) + 1
    # 单条就超预算时也要留最新的这条（截断），否则长消息会让原文层整段消失。
    if not picked and rows:
        r = dict(rows[0])
        keep = max(1, budget_chars - len(f"{r['sender'] or '某人'}：") - 1)
        r['text'] = r['text'][:keep]
        picked.append(r)
    picked.reverse()
    return picked


def list_messages(key: str, limit: int = 200, before_at: float | None = None,
                  after_at: float | None = None, oldest_first: bool = False) -> list[dict]:
    """返回原文（摘要生成与插件分页用），不做字符预算。

    oldest_first=True 时取区间内最早的一批（摘要要从上次覆盖点往后接着收）；
    否则取最新的一批（控制台“加载更早”用它）。
    """
    key = valid_scope(key)
    limit = max(1, min(1000, int(limit)))
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        sql = 'SELECT id,message_id,sender,user_id,text,at,is_self FROM messages WHERE key=?'
        args = [key]
        if before_at:
            sql += ' AND at < ?'
            args.append(float(before_at))
        if after_at:
            sql += ' AND at > ?'
            args.append(float(after_at))
        sql += ' ORDER BY at ASC LIMIT ?' if oldest_first else ' ORDER BY at DESC LIMIT ?'
        args.append(limit)
        rows = conn.execute(sql, args).fetchall()
    return [dict(r) for r in rows] if oldest_first else [dict(r) for r in reversed(rows)]


def add_summary(key: str, period_start: float, period_end: float, covered_ids=None,
                text: str = '', structured: str = '{}', model: str = '',
                value: float = 1, kind: str = 'summary') -> dict:
    key = valid_scope(key)
    text = (text or '').strip()
    if not text or len(text) > 4000:
        raise ValueError('summary text 长度必须为 1..4000')
    start, end = float(period_start or 0), float(period_end or now() * 1000)
    if end < start:
        raise ValueError('period_end 不能早于 period_start')
    value = float(value)
    if not 0 <= value <= 1:
        raise ValueError('value 必须为 0..1')
    if kind not in ('summary', 'low', 'coverage'):
        raise ValueError('kind 必须是 summary / low / coverage')
    sid = uuid.uuid4().hex
    covered = json.dumps([str(x) for x in (covered_ids or [])][:500], ensure_ascii=False)
    with _lock, db() as conn:
        conn.execute(
            'INSERT INTO session_summaries (id,key,period_start,period_end,covered_ids,text,structured,model,created_at,status,value,kind)'
            ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (sid, key, start, end, covered, text, str(structured or '{}'), str(model or ''), now(), 'active', value, kind))
    return {'id': sid, 'value': value, 'kind': kind}


def list_summaries(key: str, limit: int = 20) -> list[dict]:
    key = valid_scope(key)
    limit = max(1, min(100, int(limit)))
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            'SELECT id,period_start,period_end,text,structured,model,created_at,status,value,kind'
            ' FROM session_summaries WHERE key=? AND status=\'active\' ORDER BY period_end DESC LIMIT ?',
            (key, limit)).fetchall()
    return [dict(r) for r in rows]


def delete_summary(key: str, summary_id: str) -> dict:
    key = valid_scope(key)
    with _lock, db() as conn:
        changed = conn.execute("UPDATE session_summaries SET status='deleted' WHERE id=? AND key=? AND status='active'",
                               (str(summary_id), key)).rowcount
    return {'changed': changed}


def latest_summary_end(key: str) -> float:
    with _lock, db() as conn:
        row = conn.execute("SELECT MAX(period_end) FROM session_summaries WHERE key=? AND status='active'", (key,)).fetchone()
    return float(row[0] or 0) if row else 0.0


def context_stats(key: str) -> dict:
    key = valid_scope(key)
    with _lock, db() as conn:
        msg = conn.execute('SELECT COUNT(*), MIN(at), MAX(at) FROM messages WHERE key=?', (key,)).fetchone()
        sm = conn.execute("SELECT COUNT(*), MAX(period_end) FROM session_summaries WHERE key=? AND status='active'", (key,)).fetchone()
    return {
        'messages': int(msg[0] or 0),
        'first_at': float(msg[1] or 0),
        'last_at': float(msg[2] or 0),
        'summaries': int(sm[0] or 0),
        'last_summary_end': float(sm[1] or 0),
    }


def _lexical_terms(text: str) -> set:
    """中文按二元组、英文/数字按词切，给向量分加一点关键词命中。"""
    text = (text or '').lower()
    terms = set(re.findall(r'[a-z0-9_]{2,}', text))
    for run in re.findall(r'[\u4e00-\u9fff]+', text):
        if len(run) == 1:
            terms.add(run)
        for i in range(len(run) - 1):
            terms.add(run[i:i + 2])
    return terms


def _lexical_score(query: str, text: str) -> tuple[float, bool]:
    q_terms = _lexical_terms(query)
    if not q_terms:
        return 0.0, False
    overlap = len(q_terms & _lexical_terms(text)) / max(1, min(len(q_terms), 12))
    q_norm = MERGE_NORM.sub('', query or '')
    phrase = len(q_norm) >= 2 and q_norm in MERGE_NORM.sub('', text or '')
    return min(1.0, overlap), phrase


DEDUPE_SIM = 0.95


PRIVATE_SHARE_RE = re.compile(r'住址|地址|家庭住址|真名|真实姓名|姓名|身份证|手机号|电话号码|护照|银行卡|密码|私密|秘密|别到处说|别告诉|不要告诉|裸|性行为|病历|医院|工资|存款|定位')


def _shareable(row, scope: str) -> bool:
    """管理员私聊/旧 global 里的住址、真名、证件、身体、财务等隐私不参与跨聊天共享。"""
    if scope not in (owner_scope(), 'global'):
        return True
    hay = str(row[1] or '') + ' ' + str(row[2] or '')
    return not PRIVATE_SHARE_RE.search(hay)


def _cached_memory_matrix(conn, scope: str, shared: bool = False, include_global: bool = True):
    """按 scope 缓存 active 记忆的向量矩阵，避免每次检索都重新 stack。

    写入后最多 30 秒内可能看到旧缓存；写入路径会主动清缓存，30 秒只是兜底。
    """
    cache_key = (scope, bool(shared), bool(include_global))
    hit = _matrix_cache.get(cache_key)
    if hit and (now() - hit[0]) < _MATRIX_CACHE_TTL:
        return hit[1], hit[2]
    cols = "SELECT id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,tier,source_id,source_text,source_time,subject_id,confidence,expires_at FROM memories"
    if shared:
        rows = conn.execute(cols + " WHERE status='active'").fetchall()
    elif include_global:
        rows = conn.execute(cols + " WHERE (scope=? OR scope='global') AND status='active'", (scope,)).fetchall()
    else:
        rows = conn.execute(cols + " WHERE scope=? AND status='active'", (scope,)).fetchall()
    ts = now()
    rows = [r for r in rows if (r[16] or 0) == 0 or r[16] > ts]
    mat = np.stack([np.frombuffer(r[9], dtype=np.float32) for r in rows]) if rows else np.zeros((0, 512), dtype=np.float32)
    if len(_matrix_cache) > 32:
        _matrix_cache.clear()
    _matrix_cache[cache_key] = (ts, rows, mat)
    return rows, mat


def associate_memory(memory_id: str, scope: str | None = None, limit: int = 2, include_global: bool = False) -> list[dict]:
    """只沿 fact_key / source_id 走一跳；不递归、不扩散。"""
    scope = valid_scope(scope)
    mid = str(memory_id or '').strip()
    if not mid:
        return []
    limit = max(1, min(2, int(limit)))
    with _lock, db() as conn:
        row = conn.execute(
            "SELECT id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,tier,source_id,source_text,source_time,subject_id,confidence,expires_at,fact_key,status FROM memories WHERE id=? AND status='active'",
            (mid,),
        ).fetchone()
        if not row or (row[16] and row[16] <= time.time()):
            return []
        if row[3] != scope and not (include_global and row[3] == 'global' and _shareable(row, row[3])):
            return []
        fact_key = str(row[17] or '')
        source_id = str(row[11] or '')
        clauses = []
        params = [mid, scope]
        if fact_key:
            clauses.append("(fact_key <> '' AND fact_key = ? AND subject_id = ?)")
            params.extend([fact_key, str(row[14] or '')])
        if source_id:
            clauses.append("(source_id <> '' AND source_id = ?)")
            params.append(source_id)
        if not clauses:
            return []
        scope_sql = "(scope=? OR scope='global')" if include_global else "scope=?"
        sql = ("SELECT id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,tier,source_id,source_text,source_time,subject_id,confidence,expires_at,fact_key FROM memories "
               "WHERE status='active' AND id <> ? AND " + scope_sql + " AND (expires_at=0 OR expires_at > ?) AND (" + " OR ".join(clauses) + ") LIMIT 12")
        rows = conn.execute(sql, [*params[:2], time.time(), *params[2:]]).fetchall()
        out = []
        for r in rows:
            if not _shareable(r, r[3]):
                continue
            reason = 'same_source' if source_id and str(r[11] or '') == source_id else 'same_fact'
            out.append({
                'id': r[0], 'text': r[1], 'tags': r[2], 'scope': r[3],
                'importance': r[4], 'created_at': r[5], 'last_access': r[6],
                'tier': r[10], 'source_id': r[11], 'source_time': r[13],
                'subject_id': r[14], 'confidence': r[15], 'expires_at': r[16],
                'status': 'active', 'score': 0.5, 'reason': reason,
            })
            if len(out) >= limit:
                break
        return out

def search_memory(query: str, k: int = 5, scope: str | None = None, min_score: float = 0.35, shared: bool = False, exclude_scope: str | None = None, include_global: bool = True) -> list[dict]:
    scope = valid_scope(scope)
    if not isinstance(query, str) or not query.strip() or len(query) > 2000:
        return []
    k = max(1, min(20, int(k)))
    q = embed([query])[0]
    with _lock, db() as conn:
        rows, mat = _cached_memory_matrix(conn, scope, shared=shared, include_global=include_global)
        if not len(rows):
            return []
        sims = mat @ q
        scored = []
        for r, sim in zip(rows, sims):
            if shared and (r[3] == exclude_scope or not _shareable(r, r[3])):
                continue
            rp = 1.0 if r[10] != 'normal' else recall_prob(r[7], r[6], r[4])
            # 相关性 × 时近性 × 重要性。
            # importance 只做温和放大（0.75–1.25），避免“重要但无关”的旧事压过当前话题；
            # 相关性仍是主项，遗忘曲线决定同一话题里旧事的衰减。
            imp_factor = 0.75 + 0.5 * max(0.0, min(1.0, float(r[4])))
            score = float(sim) * (0.65 + 0.35 * rp) * imp_factor
            lex, phrase = _lexical_score(query, r[1])
            score *= 1.0 + 0.35 * lex + 0.15 * (1.0 if phrase else 0.0)
            if r[3] == 'global' and scope != 'global':
                # 旧 global 记忆是共享的，保留可召回，但别压过当前聊天里的直接证据。
                score *= 0.88
            scored.append((score, rp, float(sim), imp_factor, r, lex))
        scored.sort(key=lambda x: -x[0])
        out = []
        kept_bodies = set()
        kept_vecs = []
        for score, rp, sim, imp_factor, r, lex in scored:
            if score < min_score:
                continue
            # 同一条正文只保留最高分的一条，避免“10月1日去广场/10月2日去广场”占满 top-k。
            parsed = _parse_event(r[1])
            body = parsed[2] if parsed else MERGE_NORM.sub('', r[1] or '')
            if body and body in kept_bodies:
                continue
            vec = np.frombuffer(r[9], dtype=np.float32)
            if any(float(vec @ kv) >= DEDUPE_SIM for kv in kept_vecs):
                continue
            if body:
                kept_bodies.add(body)
            kept_vecs.append(vec)
            out.append({
                "id": r[0], "text": r[1], "tags": r[2], "scope": r[3],
                "importance": r[4], "sim": round(sim, 4), "score": round(score, 4),
                "recall": round(rp, 3), "access_count": r[8],
                'created_at': r[5],
                'evidence': {'sourceId': r[11], 'sourceText': r[12], 'sourceTime': r[13] * 1000,
                             'subjectId': r[14], 'confidence': r[15]},
                'retrieval': {'similarity': float(sim), 'retention': rp,
                              'retentionMultiplier': 0.65 + 0.35 * rp,
                              'importance': r[4], 'importanceFactor': round(imp_factor, 4),
                              'lexical': round(lex, 4),
                              'score': score,
                              'model': MODEL, 'tier': r[10], 'method': 'vector-decay'},
            })
            if len(out) >= k:
                break
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


def lookup_memories(scope, ids):
    """Revalidate a bounded set of original facts without embedding or recall side effects."""
    scope = valid_scope(scope)
    if not isinstance(ids, list) or not 1 <= len(ids) <= 3 or any(not isinstance(i, str) or len(i) > 100 for i in ids):
        raise ValueError('lookup requires 1..3 memory IDs')
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        marks = ','.join('?' for _ in ids)
        rows = conn.execute(f"SELECT id,text,source_time,subject_id FROM memories WHERE scope=? AND status='active' AND (expires_at=0 OR expires_at>?) AND id IN ({marks})", (scope, now(), *ids)).fetchall()
    return [dict(r) for r in rows]


def priority_memories(scope, subject_id):
    scope = valid_scope(scope)
    # Core context belongs to the current human, not all members of a group.
    if not str(subject_id or '').isdigit():
        return []
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT id,text,created_at,tier,scope,subject_id,source_id,source_time,expires_at,status FROM memories WHERE scope=? AND subject_id=? AND status='active' AND tier IN ('core','task') AND (expires_at=0 OR expires_at>?) ORDER BY CASE tier WHEN 'core' THEN 0 ELSE 1 END,source_time DESC LIMIT 8", (scope, str(subject_id), now())).fetchall()
    return [{**dict(r), 'score': 1.0,
             'evidence': {'sourceId': r['source_id'], 'subjectId': r['subject_id'],
                          'sourceTime': r['source_time'] * 1000}} for r in rows]


def finish_memory(scope, mid):
    _matrix_cache_clear()
    scope = valid_scope(scope)
    with _lock, db() as conn:
        changed = conn.execute("UPDATE memories SET status='completed' WHERE id=? AND scope=? AND tier='task' AND status='active'", (mid, scope)).rowcount
    return {'changed': changed}


def manage_memory(scope, subject_id, action, query='', replacement='', source_id=''):
    _matrix_cache_clear()
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
    # Confirm only this sender's candidates, through the same transactional path
    # used by the console. A conflict rolls back the entire batch.
    if action == 'confirm':
        return confirm_batch(scope, subject_id=subject_id, prefix=query)

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


class MemoryConflict(ValueError):
    def __init__(self, message, conflict=None):
        super().__init__(message)
        self.conflict = conflict


def _fingerprint(row):
    values = {k: (bytes(v).hex() if isinstance(v, (bytes, memoryview)) else v)
              for k, v in dict(row).items()}
    if values.get('fact_meta') in (None, '', '{}'):
        values.pop('fact_meta', None)  # Preserve pre-migration undo fingerprints.
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def _review_fingerprint(row):
    # Reading a fact may update retrieval counters; that must not restart every page.
    ignored = {'last_access', 'access_count', 'last_reinforced', 'strength_days', 'importance'}
    return _fingerprint({k: v for k, v in dict(row).items() if k not in ignored})


def _activation_statuses(operation):
    if operation == 'confirm':
        return ('candidate',)
    if operation == 'restore':
        return ('archived', 'deleted')
    raise ValueError('invalid memory operation')


def _confirmation_snapshot(conn, scope, mid, review=None, operation='confirm'):
    statuses = _activation_statuses(operation)
    candidate = conn.execute("SELECT * FROM memories WHERE id=? AND scope=? AND status IN (" + ','.join('?' for _ in statuses) + ')', (mid, scope, *statuses)).fetchone()
    if candidate is None:
        raise MemoryConflict('候选记忆已变化，请刷新列表后重试')
    context, selected, cached, missing = _cached_reviews(conn, candidate, operation)
    relations = _validated_review(review, context) if review is not None else cached
    if review is not None and relations is None:
        raise MemoryConflict('语义复核已过期或证据不完整，请刷新后重新确认')
    effective = {r['id']: relations.get(r['id'], fact_relation(candidate, r)) for r in selected}
    # Uncertainty is not contradiction, and equivalent facts are not competing truths.
    active = [r for r in selected if effective[r['id']] not in ('coexist', 'supplement', 'equivalent')]
    incomplete = len(selected) > 8 and len(relations) < len(selected)
    def public(row):
        return {key: row[key] for key in ('id', 'text', 'source_time', 'source_text', 'tier', 'status', 'fact_key')}
    return candidate, active, {'kind': 'confirmation-conflict', 'scope': scope, 'revision': context['revision'],
                               'operation': operation, 'review': review, 'truncated': incomplete,
                               'reviewed': len(relations), 'total': len(selected),
                               'candidate': public(candidate), 'confirmed': [public(r) for r in active],
                               'conflicts': [public(r) for r in selected if effective[r['id']] in ('conflict', 'replace')],
                               'uncertain': [public(r) for r in selected if effective[r['id']] == 'uncertain'],
                               'duplicates': [public(r) for r in selected if effective[r['id']] == 'equivalent'],
                               'coexistingCount': sum(effective[r['id']] in ('coexist', 'supplement') for r in selected)}


def _confirmation_error(conn, scope, mid, message):
    return MemoryConflict(message, _confirmation_snapshot(conn, scope, mid)[2])


def _record_confirmation(conn, scope, before):
    changes = []
    for row_id, old in before.items():
        row = conn.execute('SELECT * FROM memories WHERE id=?', (row_id,)).fetchone()
        if _fingerprint(old) != _fingerprint(row):
            changes.append({'id': row['id'], 'after': _fingerprint(row),
                            'restore': {k: old[k] for k in ('status', 'superseded_by', 'tier', 'expires_at')}})
    operation_id = uuid.uuid4().hex
    conn.execute('INSERT INTO memory_operations (id,scope,created_at,changes) VALUES (?,?,?,?)',
                 (operation_id, scope, now(), json.dumps(changes)))
    return {'kind': 'memvec-confirm', 'operationId': operation_id, 'scope': scope}


def resolve_confirmation(scope, mid, resolution, revision, review=None, operation='confirm'):
    scope = valid_scope(scope)
    if resolution not in ('keep-confirmed', 'use-candidate', 'coexist') or not isinstance(revision, str):
        raise ValueError('请选择保留已确认事实或以候选为准')
    with _lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.row_factory = sqlite3.Row
        candidate, active, snapshot = _confirmation_snapshot(conn, scope, mid, review, operation)
        if revision != snapshot['revision']:
            raise MemoryConflict('记忆在对照期间有变化，请核对最新内容后重新选择', snapshot)
        if snapshot['truncated'] and resolution != 'keep-confirmed':
            raise MemoryConflict('历史尚未全部复核，请继续检查后再处理', snapshot)
        before = {mid: dict(candidate)}
        if resolution == 'keep-confirmed':
            if operation == 'confirm':
                conn.execute("UPDATE memories SET status='archived' WHERE id=?", (mid,))
        elif resolution == 'use-candidate':
            replace_ids = {r['id'] for r in snapshot['conflicts']}
            if not replace_ids:
                raise MemoryConflict('尚未发现明确矛盾，不能据此覆盖已有事实；可以确认这条并保留全部已有记忆', snapshot)
            replacements = [r for r in active if r['id'] in replace_ids]
            for row in replacements:
                before[row['id']] = dict(row)
                conn.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?", (mid, row['id']))
            if any(row['tier'] == 'core' for row in replacements):
                conn.execute("UPDATE memories SET tier='core',expires_at=0 WHERE id=?", (mid,))
            conn.execute("UPDATE memories SET status='active' WHERE id=?", (mid,))
        if resolution == 'coexist':
            conn.execute("UPDATE memories SET status='active' WHERE id=?", (mid,))
        if operation == 'restore' and resolution != 'keep-confirmed':
            conn.execute("UPDATE memories SET superseded_by='' WHERE id=?", (mid,))
        undo = _record_confirmation(conn, scope, before)
        _matrix_cache_clear()
        return {'changed': int(operation != 'restore' or resolution != 'keep-confirmed'), 'confirmed': int(resolution != 'keep-confirmed'), 'resolution': resolution, 'undo': undo}


def _confirm_one(conn, scope, mid, before, review=None):
    _matrix_cache_clear()
    row = conn.execute("SELECT * FROM memories WHERE id=? AND scope=? AND status='candidate'", (mid, scope)).fetchone()
    if row is None:
        return 0
    _, peers, snapshot = _confirmation_snapshot(conn, scope, mid, review)
    if peers or snapshot['truncated']:
        raise MemoryConflict('请核对明确矛盾或尚不确定的关联；不确定不等于互相冲突，全部成立时可以确认并保留', snapshot)
    before[mid] = dict(row)
    conn.execute("UPDATE memories SET status='active' WHERE id=?", (mid,))
    return 1


def confirm_batch(scope, mid=None, subject_id=None, prefix='', review=None):
    scope = valid_scope(scope)
    with _lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.row_factory = sqlite3.Row
        candidates = conn.execute("""SELECT id FROM memories WHERE scope=? AND status='candidate'
            AND (? IS NULL OR id=?) AND (? IS NULL OR subject_id=?)
            AND substr(id,1,length(?))=? ORDER BY source_time,id""",
            (scope, mid, mid, subject_id, subject_id, prefix, prefix)).fetchall()
        if not candidates:
            return {'changed': 0, 'confirmed': 0}
        # Capture all affected rows, including facts superseded by a confirmation.
        before = {}
        for candidate in candidates:
            _confirm_one(conn, scope, candidate['id'], before, review)
        undo = _record_confirmation(conn, scope, before)
        return {'changed': len(candidates), 'confirmed': len(candidates),
                'undo': undo}


def confirm_memory(scope, mid, resolution=None, revision=None, review=None):
    if not isinstance(mid, str) or not mid:
        raise ValueError('id is required')
    if resolution is not None:
        return resolve_confirmation(scope, mid, resolution, revision, review)
    return confirm_batch(scope, mid=mid, review=review)


def undo_confirm(scope, operation_id):
    _matrix_cache_clear()
    scope = valid_scope(scope)
    with _lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.row_factory = sqlite3.Row
        op = conn.execute('SELECT * FROM memory_operations WHERE id=? AND scope=?', (operation_id, scope)).fetchone()
        if not op or op['undone']:
            raise MemoryConflict('确认记录不存在或已经撤销')
        changes = json.loads(op['changes'])
        affected = {c['id'] for c in changes}
        for change in changes:
            row = conn.execute('SELECT * FROM memories WHERE id=?', (change['id'],)).fetchone()
            if row is None or _fingerprint(row) != change['after']:
                raise MemoryConflict('相关记忆后来又被改过，不能覆盖后续修改')
            if change['restore']['status'] == 'active':
                conflicts = [r for r in conn.execute("SELECT * FROM memories WHERE scope=? AND subject_id=? AND status='active' AND id<>?", (scope, row['subject_id'], row['id'])) if fact_relation(row, r) == 'conflict' or (fact_relation(row, r) == 'uncertain' and ((row['fact_key'] and row['fact_key'] == r['fact_key']) or r['related_id'] == row['id']))]
                if any(r['id'] not in affected for r in conflicts):
                    raise MemoryConflict('已有后续事实，不能恢复成互相冲突的记忆')
        for change in changes:
            old = change['restore']
            conn.execute('UPDATE memories SET status=?,superseded_by=?,tier=?,expires_at=? WHERE id=?',
                         (old['status'], old['superseded_by'], old['tier'], old['expires_at'], change['id']))
        conn.execute('UPDATE memory_operations SET undone=1 WHERE id=?', (operation_id,))
        return {'changed': len(changes), 'operationId': operation_id}


def restore_memory(scope, mid, resolution=None, revision=None, review=None):
    scope = valid_scope(scope)
    if resolution is not None:
        return {'id': mid, **resolve_confirmation(scope, mid, resolution, revision, review, 'restore')}
    with _lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.row_factory = sqlite3.Row
        row, peers, snapshot = _confirmation_snapshot(conn, scope, mid, review, 'restore')
        if peers or snapshot['truncated']:
            raise MemoryConflict('恢复前需要核对与当前事实的关系，原记录尚未改变', snapshot)
        before = {mid: dict(row)}
        conn.execute("UPDATE memories SET status='active',superseded_by='' WHERE id=?", (mid,))
        _matrix_cache_clear()
        return {'id': mid, 'status': 'active', 'changed': 1, 'undo': _record_confirmation(conn, scope, before)}


def decay(prune: bool = True) -> dict:
    _matrix_cache_clear()
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
        messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        summaries = conn.execute("SELECT COUNT(*) FROM session_summaries WHERE status='active'").fetchone()[0]
    return {
        'version': '0.8.13',
        'capabilities': ['confirmation-relation-groups', 'source-lookup', 'transactional-confirm', 'confirmation-conflicts', 'fact-relations', 'unified-fact-review', 'paged-fact-review', 'context-window', 'event-merge'],
        'embed_threads': EMBED_THREADS,
        'index': 'exact-cache',
        'ann_threshold': ANN_MIN,
        "total": total,
        "scopes": {s: c for s, c in scopes},
        "messages": messages,
        "summaries": summaries,
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
            elif self.path == "/message":
                b = self._body()
                # 桥接用 camelCase（messageId/userId/isSelf），控制台用 snake_case；两边都收。
                r = add_message(
                    key=b.get("key", ""),
                    message_id=b.get("message_id", b.get("messageId", "")),
                    sender=b.get("sender", ""),
                    user_id=b.get("user_id", b.get("userId", "")),
                    text=b.get("text", ""),
                    at=b.get("at"),
                    is_self=b.get("is_self", b.get("isSelf", False)),
                    meta=b.get("meta", ""),
                )
                self._send(200, {"ok": True, "message": r})
            elif self.path == "/context":
                b = self._body()
                key = b.get("key", "")
                after = b.get("afterAt")
                if after is None:
                    after = latest_summary_end(key)
                rows = context_messages(key, int(b.get("limit", 200)),
                                        int(b.get("budgetChars", 8000)), b.get("beforeAt"), after)
                summaries = list_summaries(key, 3)
                self._send(200, {"ok": True, "messages": rows, "summaries": summaries, "count": len(rows)})
            elif self.path == "/messages":
                b = self._body()
                rows = list_messages(b.get("key", ""), int(b.get("limit", 200)),
                                     b.get("beforeAt"), b.get("afterAt"),
                                     b.get("oldestFirst") is True)
                self._send(200, {"ok": True, "messages": rows, "count": len(rows)})
            elif self.path == "/summary":
                b = self._body()
                self._send(200, {"ok": True, **add_summary(**b)})
            elif self.path == "/summaries":
                b = self._body()
                key = b.get("key", "")
                summaries = list_summaries(key, int(b.get("limit", 20)))
                self._send(200, {"ok": True, "summaries": summaries})
            elif self.path == "/summary/delete":
                b = self._body()
                self._send(200, {"ok": True, **delete_summary(b.get("key", ""), b.get("id", ""))})
            elif self.path == "/context/stats":
                b = self._body()
                self._send(200, {"ok": True, **context_stats(b.get("key", ""))})
            elif self.path == "/associate":
                b = self._body()
                r = associate_memory(b.get("id", ""), b.get("scope"), int(b.get("limit", 2)), bool(b.get("include_global", False)))
                self._send(200, {"ok": True, "results": r})
            elif self.path == "/search":
                b = self._body()
                r = search_memory(b.get("query", ""), int(b.get("k", 5)), b.get("scope"), float(b.get('min_score', 0.35)), bool(b.get('shared', False)), b.get('exclude_scope'), bool(b.get('include_global', True)))
                self._send(200, {"ok": True, "results": r})
            elif self.path == '/reinforce':
                b = self._body()
                self._send(200, {'ok': True, **reinforce(b.get('scope'), b.get('ids', []))})
            elif self.path == '/priority':
                b = self._body()
                self._send(200, {'ok': True, 'results': priority_memories(b.get('scope'), b.get('subject_id'))})
            elif self.path == '/manage':
                self._send(200, {'ok': True, **manage_memory(**self._body())})
            elif self.path == '/lookup':
                b = self._body()
                self._send(200, {'ok': True, 'results': lookup_memories(b.get('scope'), b.get('ids'))})
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
            elif self.path == '/confirm/context':
                b = self._body()
                self._send(200, {'ok': True, **confirmation_context(b.get('scope'), b.get('id'), b.get('operation', 'confirm'))})
            elif self.path == '/confirm/review':
                b = self._body()
                self._send(200, {'ok': True, **save_review_page(b.get('scope'), b.get('id'), b.get('operation', 'confirm'), b.get('offset'), b.get('review'))})
            elif self.path == '/restore':
                b = self._body()
                self._send(200, {'ok': True, **restore_memory(b.get('scope'), b.get('id'), b.get('resolution'), b.get('revision'), b.get('review'))})
            elif self.path == '/confirm':
                b = self._body()
                self._send(200, {'ok': True, **confirm_memory(b.get('scope'), b.get('id'), b.get('resolution'), b.get('revision'), b.get('review'))})
            elif self.path == '/confirm/undo':
                b = self._body()
                self._send(200, {'ok': True, **undo_confirm(b.get('scope'), b.get('operationId'))})
            elif self.path.startswith("/decay"):
                b = self._body()
                self._send(200, {"ok": True, "result": decay(bool(b.get("prune", True)))})
            elif self.path == "/consolidate":
                b = self._body()
                scope = b.get("scope") or ""
                dry = bool(b.get("dry", False))
                result = consolidate_scope(scope, dry=dry) if scope else consolidate_all(dry=dry)
                self._send(200, {"ok": True, "result": result})
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except MemoryConflict as e:
            self._send(409, {'ok': False, 'error': str(e), **({'conflict': e.conflict} if e.conflict else {})})
        except ValueError as e:
            self._send(400, {'ok': False, 'error': str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})


def main():
    get_model()  # 先把模型加载好，避免第一个请求超时
    conn = db()
    conn.close()
    Thread(target=_consolidate_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"memvec listening on 127.0.0.1:{PORT}, db={DB_PATH}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
