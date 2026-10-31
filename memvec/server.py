"""本地记忆向量库 + 遗忘曲线服务（给 QQ 里的鱼用）。

设计：
  - 向量：BAAI/bge-small-zh-v1.5（fastembed，ONNX，CPU 即可）
  - 存储：sqlite3（stdlib），向量存 BLOB
  - 可用程度：幂律形状 R(t) = (1 + t/S)^(-1)，S 是分数减半的时间（天），
    查询不强化；本人再次明确表达时有节制强化。核心记忆和待办不自然衰减。
  - 接口：POST /add /search /decay，GET /stats，监听 127.0.0.1:9881

为什么用幂律而不是指数：指数曲线衰减太快（考试前突击那种），
    该曲线受研究启发，参数是工程默认，不是对人类回忆概率的测量。
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
HALF_LIFE_DAYS = 7.0  # Availability half-time, not a human recall probability.
STRENGTH_CAP_DAYS = 365.0  # Engineering ceiling after spaced, evidenced experience.
RETENTION_VERSION = 2
RETENTION_GRACE_DAYS = 14
ANN_MIN = int(os.environ.get('MEMVEC_ANN_MIN', '20000'))
PRUNE_R = 0.12
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


def initial_strength(scope: str, tags: str = '', importance: float = .5) -> float:
    # Content-based engineering defaults; scope never grants memory privilege.
    kinds = set(re.split(r'[,;，；\s]+', str(tags or '').lower()))
    base = 30.0 if kinds & {'preference', 'habit', '偏好', '习惯'} else 3.0 if 'episode' in kinds else 7.0
    value = float(importance)
    value = min(1.0, max(0.0, value)) if math.isfinite(value) else .5
    return base * (.5 + value)


def retention_policy(conn):
    row = conn.execute('SELECT migrated_at FROM memory_retention_migrations WHERE version=?', (RETENTION_VERSION,)).fetchone()
    at = float(row[0]) if row else 0
    return {'version': RETENTION_VERSION, 'migratedAt': at * 1000,
            'graceUntil': (at + RETENTION_GRACE_DAYS * 86400) * 1000 if at else 0,
            'strengthMeaning': 'availability-half-time', 'scopeBias': False}


def _reinforce_evidence(conn, mid, subject, source_id, source_time, ts):
    row = conn.execute('SELECT status,subject_id,source_id,source_time,last_access,last_reinforced,strength_days,expires_at FROM memories WHERE id=?', (mid,)).fetchone()
    if (row is None or row[0] != 'active' or not subject or row[1] != subject or not source_id or
            source_id == row[2] or not math.isfinite(source_time) or source_time <= row[3] or source_time > ts + 60 or
            (row[7] and row[7] <= ts)):
        return False
    anchor = max(float(row[4]), float(row[5]))
    gap = (source_time - anchor) / 86400
    if gap < 1:
        return False
    strength = max(.1, float(row[6]))
    growth = 1.15 + .35 * min(1.0, gap / strength)
    conn.execute('UPDATE memories SET last_access=?,last_reinforced=?,strength_days=?,access_count=access_count+1 WHERE id=?',
                 (source_time, source_time, min(STRENGTH_CAP_DAYS, strength * growth), mid))
    return True


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
    conn.execute("""CREATE TABLE IF NOT EXISTS memory_share_grants (
        memory_id TEXT NOT NULL, target_scope TEXT NOT NULL, content_hash TEXT NOT NULL,
        granted_at REAL NOT NULL, PRIMARY KEY(memory_id,target_scope)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS sharing_privacy (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL,
        level TEXT NOT NULL, share_text TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL, reviewed_at REAL NOT NULL, PRIMARY KEY(kind,id)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS sharing_blocks (
        memory_id TEXT NOT NULL,target_scope TEXT NOT NULL,PRIMARY KEY(memory_id,target_scope)
    )""")
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
    conn.execute("""CREATE TABLE IF NOT EXISTS memory_evidence_reviews (
        scope TEXT NOT NULL, memory_id TEXT NOT NULL, operation TEXT NOT NULL,
        revision TEXT NOT NULL, schema_version INTEGER NOT NULL, verdict TEXT NOT NULL,
        created_at REAL NOT NULL,
        PRIMARY KEY(scope,memory_id,operation,revision)
    )""")
    # Pair receipts remain valid when unrelated facts are added or reordered.
    # Full-set revisions still guard final confirmation and concurrent writes.
    conn.execute("""CREATE TABLE IF NOT EXISTS memory_pair_receipts (
        scope TEXT NOT NULL, memory_id TEXT NOT NULL, operation TEXT NOT NULL,
        related_id TEXT NOT NULL, candidate_hash TEXT NOT NULL, related_hash TEXT NOT NULL,
        verdict TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(scope,memory_id,operation,related_id)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS memory_source_receipts (
        scope TEXT NOT NULL, memory_id TEXT NOT NULL, operation TEXT NOT NULL,
        candidate_hash TEXT NOT NULL, verdict TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(scope,memory_id,operation)
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
    conn.execute('CREATE TABLE IF NOT EXISTS memory_retention_migrations (version INTEGER PRIMARY KEY,migrated_at REAL NOT NULL,previous_strengths TEXT NOT NULL)')
    # One-time migration changes no evidence, status, expiry or source timestamp.
    global _strength_migrated
    if not _strength_migrated:
        if conn.execute('SELECT 1 FROM memory_retention_migrations WHERE version=?', (RETENTION_VERSION,)).fetchone() is None:
            old = conn.execute('SELECT id,scope,tags,importance,strength_days FROM memories').fetchall()
            cursor = conn.execute('SELECT * FROM memories')
            names = [column[0] for column in cursor.description]
            before_rows = {row[0]: dict(zip(names, row)) for row in cursor.fetchall()}
            hashes = {}
            for row in old:
                strength = initial_strength(row[1], row[2], row[3])
                conn.execute('UPDATE memories SET strength_days=? WHERE id=?', (strength, row[0]))
                before = before_rows[row[0]]
                hashes[row[0]] = (_fingerprint(before), _fingerprint({**before, 'strength_days': strength}))
            # Preserve only undo receipts that were valid before this non-semantic
            # migration; never revive a receipt already invalidated by other edits.
            for op_id, encoded in conn.execute('SELECT id,changes FROM memory_operations').fetchall():
                changes = json.loads(encoded)
                changed = False
                for item in changes:
                    pair = hashes.get(item['id'])
                    if pair and item['after'] == pair[0]:
                        item['after'] = pair[1]; changed = True
                if changed:
                    conn.execute('UPDATE memory_operations SET changes=? WHERE id=?', (json.dumps(changes), op_id))
            conn.execute('INSERT INTO memory_retention_migrations VALUES (?,?,?)',
                         (RETENTION_VERSION, now(), json.dumps([{'id': r[0], 'strength': r[4]} for r in old])))
        conn.commit()
        _strength_migrated = True
    return conn


def embed(texts: list[str]) -> np.ndarray:
    vecs = [np.asarray(v, dtype=np.float32) for v in get_model().embed(texts)]
    m = np.stack(vecs)
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.maximum(norms, 1e-9)


def recall_prob(strength_days: float, last_access: float, importance: float) -> float:
    # Importance enters initial stability/ranking, not an everlasting floor.
    t_days = max(0.0, (now() - last_access) / 86400.0)
    return 1.0 / (1.0 + t_days / max(strength_days, 0.1))


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


RELATED_SEMANTIC_K = 6  # 语义兜底条数：只拿最像的几条，不再拖整个聊天的旧记忆


def review_scope() -> str:
    """审核范围：'all'（默认）或 'related'。

    all     = 同主体、同聊天里全部活着的旧事实都进审核。能证明“与任何旧事实都
              不冲突”，但在长期私聊里会退化成每次几十对无关比较：噪声级的低置信
              度会把候选永久卡在“关系不确定”，每新增一条记忆还会让已完成的结论
              作废（永远差最后几条）。
    related = 只审同一件事（同 fact_key 或同 object+attribute）的旧事实，再用语义
              最近几条兜底。一次调用内判完，代价是只能证明“与相关事实不冲突”。

    默认保持 all，用 MEMVEC_REVIEW_SCOPE=related 或本目录的 review-scope.txt 显式开启。
    """
    value = (os.environ.get('MEMVEC_REVIEW_SCOPE') or '').strip().lower()
    if not value:
        try:
            with open(os.path.join(HOME, 'review-scope.txt'), 'r', encoding='utf-8') as f:
                value = f.read().strip().lower()
        except OSError:
            value = ''
    return 'related' if value.startswith('related') else 'all'


def _prioritized_rows(candidate, rows, similarity):
    """旧行为：一条都不丢，只把同一件事排到最前面。"""
    candidate_fact = stored_fact(candidate)
    def priority(row):
        other = stored_fact(row)
        same = bool(candidate_fact and other and
                    candidate_fact['object'] == other['object'] and
                    candidate_fact['attribute'] == other['attribute'])
        # Model-extracted structure only affects order, never approval/omission.
        return (same, similarity(row))
    ranked = sorted(rows, key=priority, reverse=True)
    # Explicit links first, then structured overlap and semantics.
    selected = [r for r in rows if r['id'] == candidate['related_id']]
    return selected + [r for r in ranked if r not in selected]


def _same_aspect(candidate_fact, other_fact, candidate_key='', other_key=''):
    """同一件事 = 同一 fact_key，或同一 object+attribute。

    审核要回答的是“这条新事实会不会和已有的同一件事冲突”，不是“会不会和这个
    聊天里任何一条记忆冲突”。不同方面的事实结构上无关，交给语义兜底即可。
    """
    if candidate_key and other_key and candidate_key == other_key:
        return True
    if not candidate_fact or not other_fact:
        return False
    return (candidate_fact.get('object') == other_fact.get('object')
            and candidate_fact.get('attribute') == other_fact.get('attribute'))


def _related_rows(candidate, rows, similarity):
    candidate_fact = stored_fact(candidate)
    candidate_key = candidate['fact_key'] or ''
    explicit, same, rest = [], [], []
    for row in rows:
        if row['id'] == candidate['related_id']:
            explicit.append(row)
        elif _same_aspect(candidate_fact, stored_fact(row), candidate_key, row['fact_key'] or ''):
            same.append(row)
        else:
            rest.append(row)
    same.sort(key=similarity, reverse=True)
    rest.sort(key=similarity, reverse=True)
    selected, seen = [], set()
    for row in [*explicit, *same, *rest[:RELATED_SEMANTIC_K]]:
        if row['id'] in seen:
            continue
        seen.add(row['id'])
        selected.append(row)
    return selected


def _review_context(conn, candidate, offset=0, all_rows=False):
    rows = conn.execute("SELECT * FROM memories WHERE scope=? AND subject_id=? AND status='active' AND id<>? AND (expires_at=0 OR expires_at>?) ORDER BY id",
                        (candidate['scope'], candidate['subject_id'], candidate['id'], now())).fetchall()
    q = np.frombuffer(candidate['embedding'], dtype=np.float32)
    def similarity(row):
        v = np.frombuffer(row['embedding'], dtype=np.float32)
        return float(v @ q) if v.shape == q.shape else -1.0
    # Same-aspect facts keep every entry (they are the ones that can conflict);
    # everything else only joins as a short semantic fallback.
    if review_scope() == 'related':
        related = _related_rows(candidate, rows, similarity)
    else:
        related = _prioritized_rows(candidate, rows, similarity)
    total = len(related)
    selected = related if all_rows else related[offset:offset+8]
    # Version covers only the reviewed facts: a new unrelated memory must not
    # invalidate a review that has already been completed and paid for.
    revision = hashlib.sha256(json.dumps([_review_fingerprint(candidate), *[_review_fingerprint(r) for r in related]]).encode()).hexdigest()
    def public(row):
        return {**{k: row[k] for k in ('id','text','source_time','tier')}, 'quote': fact_quote(row['text']), 'fact': stored_fact(row)}
    return {'scope': candidate['scope'], 'reviewScope': review_scope(), 'candidate': public(candidate), 'related': [public(r) for r in selected],
            'revision': revision, 'truncated': total > offset+len(selected),
            'offset': offset, 'total': total}, selected


def _cached_reviews(conn, candidate, operation):
    context, rows = _review_context(conn, candidate, all_rows=True)
    relations = {}
    cached = {r['page_offset']: r['review'] for r in conn.execute(
        'SELECT page_offset,review FROM memory_review_pages WHERE scope=? AND memory_id=? AND operation=? AND revision=?',
        (candidate['scope'], candidate['id'], operation, context['revision']))}
    next_offset = None
    candidate_hash = _review_fingerprint(candidate)
    pairs = {r['related_id']: r for r in conn.execute(
        'SELECT * FROM memory_pair_receipts WHERE scope=? AND memory_id=? AND operation=? AND candidate_hash=?',
        (candidate['scope'], candidate['id'], operation, candidate_hash))}
    for offset in range(0, len(rows), 8):
        page = {**context, 'related': context['related'][offset:offset+8]}
        try:
            verdict = _validated_review(json.loads(cached.get(offset, 'null')), page)
        except (ValueError, TypeError):
            verdict = None
        if verdict is None:
            reused = {}
            for row, public in zip(rows[offset:offset+8], page['related']):
                receipt = pairs.get(row['id'])
                if receipt is None or receipt['related_hash'] != _review_fingerprint(row):
                    continue
                try:
                    single = {**page, 'related': [public]}
                    saved = {'revision': context['revision'], 'candidateEvidence': context['candidate']['quote'],
                             'relations': [json.loads(receipt['verdict'])]}
                    validated = _validated_review(saved, single)
                    if validated is not None:
                        reused.update(validated)
                except (ValueError, TypeError):
                    pass
            # Keep each valid pair even when its neighbours are new/changed.
            # Dropping a partially cached page resent up to seven reviewed facts.
            verdict = reused
        if verdict is not None:
            relations.update(verdict)
        if any(row['id'] not in relations for row in rows[offset:offset+8]) and next_offset is None:
            next_offset = offset
    return context, rows, relations, next_offset


def _valid_evidence_verdict(verdict, candidate, revision):
    if not isinstance(verdict, dict) or verdict.get('id') != candidate['id'] or verdict.get('revision') != revision:
        return False
    if not candidate['source_id'] or not candidate['subject_id'] or not candidate['source_text'] or len(candidate['source_text']) > 500:
        return False
    if verdict.get('evidence') != candidate['source_text'] or any(type(verdict.get(k)) is not bool for k in ('supported','speakerMatches','literal','current')):
        return False
    confidence = verdict.get('confidence')
    return (not isinstance(confidence, bool) and isinstance(confidence, (int, float)) and math.isfinite(confidence)
            and 0 <= confidence <= 1 and ('reason' not in verdict or isinstance(verdict['reason'], str) and len(verdict['reason']) <= 100))


def _cached_evidence(conn, candidate, operation, revision):
    rebased = False
    row = conn.execute('SELECT verdict FROM memory_evidence_reviews WHERE scope=? AND memory_id=? AND operation=? AND revision=? AND schema_version=1',
                       (candidate['scope'], candidate['id'], operation, revision)).fetchone()
    if row is None:
        row = conn.execute('SELECT verdict FROM memory_source_receipts WHERE scope=? AND memory_id=? AND operation=? AND candidate_hash=?',
                           (candidate['scope'], candidate['id'], operation, _review_fingerprint(candidate))).fetchone()
        if row is None:
            return None
        rebased = True
    try:
        value = json.loads(row['verdict'])
        # Only the dependency-matched receipt is rebased onto the latest set revision.
        # This cannot confirm a candidate until all current related facts pass too.
        if rebased:
            value = {**value, 'revision': revision}
        return value if _valid_evidence_verdict(value, candidate, revision) else None
    except (ValueError, TypeError):
        return None


def _accepted_evidence(verdict):
    return bool(verdict and all(verdict.get(k) is True for k in ('supported','speakerMatches','literal','current')) and verdict.get('confidence', 0) >= .95)


def _automatic_readiness(conn, candidate, operation, context, relations, missing):
    # A completed review may still be uncertain. Completion is not permission
    # to confirm; keep the transaction's independent checks as the final guard.
    evidence = _cached_evidence(conn, candidate, operation, context['revision'])
    if evidence is not None and not _accepted_evidence(evidence):
        return {'status': 'manual', 'dependency': 'source', 'reason': '原话支持不足或存在歧义，保留待确认'}
    conflicts = sum(v in ('conflict', 'replace') for v in relations.values())
    uncertain = sum(v == 'uncertain' for v in relations.values())
    if conflicts or uncertain:
        source = '原话核对已通过；' if _accepted_evidence(evidence) else '原话尚未核对；'
        progress = f'已复核 {len(relations)}/{context["total"]} 条；' if missing is not None else ''
        reason = f'{source}{progress}{conflicts} 条关系存在矛盾或替换，{uncertain} 条关系尚不确定。自动核对暂缓，可手动继续；已有事实未改动'
        return {'status': 'manual', 'dependency': 'relations', 'reason': reason, 'conflicts': conflicts, 'uncertain': uncertain}
    if missing is not None:
        return {'status': 'reviewing', 'reason': '历史关系尚未全部复核'}
    if evidence is None:
        return {'status': 'reviewing', 'reason': '完整原话尚未核对'}
    return {'status': 'ready', 'conflicts': 0, 'uncertain': 0}


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
        context['related'] = [row for row in context['related'] if row['id'] not in relations]
        context['reviewed'] = len(relations)
        return {'needed': offset is not None, 'context': context,
                'evidenceVerdict': _cached_evidence(conn, candidate, operation, full['revision']),
                'evidence': {'id': candidate['id'], 'text': candidate['text'], 'quote': candidate['source_text'],
                             'sourceId': candidate['source_id'], 'subjectId': candidate['subject_id']},
                'reviewed': len(relations), 'total': full['total'],
                'automatic': _automatic_readiness(conn, candidate, operation, full, relations, offset)}


def save_review_page(scope, mid, operation, offset, review, evidence_only=False):
    scope = valid_scope(scope)
    statuses = _activation_statuses(operation)
    if type(evidence_only) is not bool or isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset % 8 or evidence_only and offset != 0:
        raise ValueError('invalid review offset')
    with _lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.row_factory = sqlite3.Row
        candidate = conn.execute("SELECT * FROM memories WHERE scope=? AND id=? AND status IN (" + ','.join('?' for _ in statuses) + ')', (scope, mid, *statuses)).fetchone()
        if candidate is None:
            raise MemoryConflict('记忆状态已变化，请重新开始复核')
        context, rows = _review_context(conn, candidate, offset)
        if not isinstance(review, dict) or review.get('revision') != context['revision']:
            raise MemoryConflict('复核版本已变化，已有事实未改变')
        evidence = review.get('evidenceVerdict')
        if 'evidenceVerdict' in review and not _valid_evidence_verdict(evidence, candidate, context['revision']):
            raise MemoryConflict('原话核对回执无效，已有事实未改变')
        if evidence_only:
            if evidence is None or review.get('relations') != [] or review.get('candidateEvidence') != context['candidate']['quote']:
                raise MemoryConflict('原话核对回执不完整，已有事实未改变')
        else:
            _, _, cached_relations, _ = _cached_reviews(conn, candidate, operation)
            missing_rows = [row for row in rows if row['id'] not in cached_relations]
            delta_context = {**context, 'related': [row for row in context['related'] if row['id'] not in cached_relations]}
            # Accept either the exact missing subset or a complete legacy page.
            # Never accept arbitrary omissions, another page, or a stale revision.
            if missing_rows and _validated_review(review, delta_context) is not None:
                rows = missing_rows
            elif not rows or _validated_review(review, context) is None:
                raise MemoryConflict('复核版本已变化或该批证据不完整；已有事实未改变')
        if evidence is not None:
            conn.execute('DELETE FROM memory_evidence_reviews WHERE scope=? AND memory_id=? AND operation=? AND revision<>?',
                         (scope, mid, operation, context['revision']))
            conn.execute('INSERT OR REPLACE INTO memory_evidence_reviews VALUES (?,?,?,?,?,?,?)',
                         (scope, mid, operation, context['revision'], 1, json.dumps(evidence, ensure_ascii=False), now()))
            conn.execute('INSERT OR REPLACE INTO memory_source_receipts VALUES (?,?,?,?,?,?)',
                         (scope, mid, operation, _review_fingerprint(candidate), json.dumps(evidence, ensure_ascii=False), now()))
        if not evidence_only:
            conn.execute('DELETE FROM memory_review_pages WHERE scope=? AND memory_id=? AND operation=? AND revision<>?',
                         (scope, mid, operation, context['revision']))
            conn.execute('INSERT OR REPLACE INTO memory_review_pages VALUES (?,?,?,?,?,?,?)',
                         (scope, mid, operation, context['revision'], offset, json.dumps(review, ensure_ascii=False), now()))
            by_id = {item['id']: item for item in review['relations']}
            for row in rows:
                conn.execute('INSERT OR REPLACE INTO memory_pair_receipts VALUES (?,?,?,?,?,?,?,?)',
                             (scope, mid, operation, row['id'], _review_fingerprint(candidate), _review_fingerprint(row),
                              json.dumps(by_id[row['id']], ensure_ascii=False), now()))
        full, _, relations, missing = _cached_reviews(conn, candidate, operation)
        return {'pending': missing is not None, 'reviewed': len(relations), 'total': full['total'],
                'automatic': _automatic_readiness(conn, candidate, operation, full, relations, missing)}


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
                _reinforce_evidence(conn, prior[0], subject, source_id, source_time, ts)
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
                    _reinforce_evidence(conn, target_id, subject, source_id, source_time, ts)
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
            (mid, text, tags, scope, float(importance), ts, ts, initial_strength(scope, tags, importance), 0, vec.tobytes()),
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
        _reinforce_evidence(conn, row[0], subject, source_id, source_time, ts)
        stable = conn.execute('SELECT strength_days,last_access FROM memories WHERE id=?', (row[0],)).fetchone()
        new_strength = float(stable[0])
        old_source = str(row[5] or '')
        combined_source = (old_source + '\n' + (source_text or '')).strip()[-1200:]
        conn.execute(
            "UPDATE memories SET text=?,embedding=?,importance=?,strength_days=?,last_access=?,"
            "access_count=access_count+1,tier=?,expires_at=CASE WHEN ?='core' THEN 0 ELSE expires_at END,"
            "source_id=?,source_text=?,source_time=MAX(source_time,?) WHERE id=?",
            (merged_text, vec.tobytes(), new_imp, new_strength, stable[1], new_tier, new_tier,
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
            best_strength = max(it['strength'] for it in items)  # Housekeeping is not experience.
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


def _share_hash(row):
    # Authorization covers this precise fact/version, not future edits or its
    # entire conversation. A later correction requires a new grant.
    import hashlib
    fields = ('id', 'text', 'tags', 'scope', 'subject_id', 'source_id', 'source_text', 'source_time', 'expires_at', 'fact_key')
    return hashlib.sha256(json.dumps({k: row[k] for k in fields}, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def _granted_memory_ids(conn, target_scope):
    cols = 'm.id,m.text,m.tags,m.scope,m.subject_id,m.source_id,m.source_text,m.source_time,m.expires_at,m.fact_key,g.content_hash'
    cur = conn.execute(f"SELECT {cols} FROM memories m JOIN memory_share_grants g ON g.memory_id=m.id WHERE g.target_scope=? AND m.status='active' AND (m.expires_at=0 OR m.expires_at>?)", (target_scope, now()))
    names = [d[0] for d in cur.description]
    rows = [dict(zip(names, r)) for r in cur.fetchall()]
    allowed = {r['id'] for r in rows if r['content_hash'] == _share_hash(r)}
    policies = {r['id']: r for r in _dict_rows(conn, "SELECT * FROM sharing_privacy WHERE kind='memory'")}
    for row in _dict_rows(conn, "SELECT * FROM memories WHERE status='active' AND (expires_at=0 OR expires_at>?)", (now(),)):
        policy = policies.get(row['id'])
        if not policy:
            continue
        if policy['origin'] == 'manual' and policy['level'] == 'private':
            allowed.discard(row['id'])
        elif policy['revision'] == _share_hash(row) and policy['level'] == 'public':
            allowed.add(row['id'])
    blocked = {r[0] for r in conn.execute('SELECT memory_id FROM sharing_blocks WHERE target_scope=?', (target_scope,))}
    return allowed - blocked


def _dict_rows(conn, sql, args=()):
    cur = conn.execute(sql, args)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def _summary_share_hash(row):
    return hashlib.sha256(json.dumps({k: row[k] for k in ('id','key','text','structured','covered_ids','period_start','period_end')}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _participated(conn, row):
    messages = _dict_rows(conn, 'SELECT id,message_id FROM messages WHERE key=? AND is_self=1 AND at BETWEEN ? AND ?', (row['key'],row['period_start'],row['period_end']))
    try: covered = set(json.loads(row['covered_ids'] or '[]'))
    except (ValueError, TypeError): return False
    return any(not covered or m['id'] in covered or m['message_id'] in covered for m in messages)


def sharing_context(scope, query='', include_summaries=False):
    scope = valid_scope(scope)
    query = str(query or '')[:1000]
    pending, summaries = [], []
    with _lock, db() as conn:
        policies = {(r['kind'],r['id']):r for r in _dict_rows(conn,'SELECT * FROM sharing_privacy')}
        blocked = {r[0] for r in conn.execute('SELECT memory_id FROM sharing_blocks WHERE target_scope=?',(scope,))}
        memories = _dict_rows(conn,"SELECT * FROM memories WHERE scope<>? AND status='active' AND (expires_at=0 OR expires_at>?)",(scope,now()))
        unknown=[]
        for r in memories:
            if r['id'] in blocked: continue
            revision=_share_hash(r);p=policies.get(('memory',r['id']))
            if p and (p['revision']==revision or p['origin']=='manual' and p['level']=='private'): continue
            unknown.append((r,revision))
        # Rank locally; no language model call for query matching.
        if unknown and query:
            q=embed([query])[0]
            ranked=sorted([(float(np.frombuffer(r['embedding'],dtype=np.float32)@q),r,rev) for r,rev in unknown],key=lambda x:-x[0])
            for score,r,rev in ranked:
                if score<.4 or len(pending)>=4: continue
                # Do not classify with silently clipped confidentiality context.
                if len(r['text'])>2000 or len(r['source_text'] or '')>3000: continue
                pending.append({'kind':'memory','id':r['id'],'scope':r['scope'],'revision':rev,'text':r['text'],'sourceText':r['source_text'] or ''})
        if include_summaries and scope==owner_scope():
            for r in _dict_rows(conn,"SELECT * FROM session_summaries WHERE key<>? AND status='active' AND kind='summary' ORDER BY period_end DESC LIMIT 40",(scope,)):
                if not _participated(conn,r): continue
                rev=_summary_share_hash(r);p=policies.get(('summary',r['id']))
                if p and p['revision']==rev:
                    if p['level']=='public' and p['share_text'] and len(summaries)<2:
                        summaries.append({'id':r['id'],'scope':r['key'],'text':p['share_text'],'at':r['period_end'],'participated':True})
                elif len(pending)<6 and sum(p['kind']=='summary' for p in pending)<2 and len(r['text'])<=5000 and len(r['structured'] or '')<=5000:
                    pending.append({'kind':'summary','id':r['id'],'scope':r['key'],'revision':rev,'text':r['text'],'sourceText':r['structured'],'participated':True})
                if len(summaries)>=2: break
    return {'pending':pending,'summaries':summaries}


def save_sharing_reviews(reviews):
    if not isinstance(reviews,list) or not 1<=len(reviews)<=6: raise ValueError('invalid privacy batch')
    with _lock, db() as conn:
        for verdict in reviews:
            kind=verdict.get('kind');mid=str(verdict.get('id',''));level=verdict.get('level')
            if kind not in ('memory','summary') or level not in ('public','private','uncertain'): raise ValueError('invalid privacy verdict')
            table='memories' if kind=='memory' else 'session_summaries'
            rows=_dict_rows(conn,f"SELECT * FROM {table} WHERE id=? AND status='active'",(mid,))
            if not rows: continue
            row=rows[0];revision=_share_hash(row) if kind=='memory' else _summary_share_hash(row)
            if verdict.get('revision')!=revision: continue
            old=conn.execute('SELECT origin,level,revision FROM sharing_privacy WHERE kind=? AND id=?',(kind,mid)).fetchone()
            if old and old[0]=='manual' and (old[1]=='private' or old[2]==revision): continue
            confidence=verdict.get('confidence')
            if type(confidence) not in (int,float) or not 0<=confidence<=1: raise ValueError('invalid privacy confidence')
            if level=='public' and confidence<.9: level='uncertain'
            shared=''
            if kind=='summary' and level=='public':
                parts=verdict.get('excerpts')
                if not isinstance(parts,list) or not 1<=len(parts)<=2 or any(not isinstance(p,str) or not p.strip() or len(p)>800 or p not in row['text'] for p in parts): raise ValueError('invalid summary evidence')
                shared='\n'.join(parts)
            reason=str(verdict.get('reason',''))[:200]
            conn.execute('INSERT OR REPLACE INTO sharing_privacy VALUES (?,?,?,?,?,?,?,?)',(kind,mid,revision,level,shared,reason,'semantic',now()))
    _matrix_cache_clear()
    return {'saved':True}


def memory_sharing(scope, mid, action='view', target_scope='', expected_hash=''):
    # Management-only route; never called by extraction or a model proposal.
    scope = 'global' if scope == 'global' else valid_scope(scope)
    if action not in ('view', 'grant', 'revoke', 'private', 'public', 'auto'):
        raise ValueError('invalid sharing action')
    if action in ('grant','revoke') and (not re.fullmatch(r'(private|group):[0-9]+', str(target_scope)) or target_scope == scope):
        raise ValueError('请选择另一个具体聊天，不能授权全部聊天')
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT * FROM memories WHERE id=? AND scope=?', (str(mid), scope)).fetchone()
        if not row:
            raise ValueError('记忆不存在或不属于此会话')
        revision = _share_hash(row)
        if action == 'grant':
            if expected_hash != revision or row['status'] != 'active' or (row['expires_at'] and row['expires_at'] <= now()):
                raise ValueError('记忆已变化、未确认或已到期，请重新查看后授权')
            conn.execute('INSERT OR REPLACE INTO memory_share_grants VALUES (?,?,?,?)', (mid, target_scope, revision, now()))
            conn.execute('DELETE FROM sharing_blocks WHERE memory_id=? AND target_scope=?',(mid,target_scope))
        elif action == 'revoke':
            conn.execute('DELETE FROM memory_share_grants WHERE memory_id=? AND target_scope=?', (mid, target_scope))
            conn.execute('INSERT OR IGNORE INTO sharing_blocks VALUES (?,?)',(mid,target_scope))
        elif action in ('private','public','auto'):
            if expected_hash!=revision: raise ValueError('记忆已变化，请刷新后操作')
            if action=='auto': conn.execute("DELETE FROM sharing_privacy WHERE kind='memory' AND id=?",(mid,))
            else: conn.execute('INSERT OR REPLACE INTO sharing_privacy VALUES (?,?,?,?,?,?,?,?)',('memory',mid,revision,action,'','管理员手动设置','manual',now()))
        grants = [dict(r) for r in conn.execute('SELECT target_scope,content_hash,granted_at FROM memory_share_grants WHERE memory_id=?', (mid,))]
        policy=conn.execute("SELECT level,origin,revision FROM sharing_privacy WHERE kind='memory' AND id=?",(mid,)).fetchone()
        blocked=[r[0] for r in conn.execute('SELECT target_scope FROM sharing_blocks WHERE memory_id=?',(mid,))]
    if action != 'view':
        _matrix_cache_clear()
    return {'id': mid, 'scope': scope, 'text': row['text'], 'revision': revision,'privacy':dict(policy) if policy else {'level':'unreviewed','origin':'auto'},'blocked':blocked,
            'grants': [{'target': g['target_scope'], 'at': g['granted_at'], 'current': g['content_hash'] == revision} for g in grants]}


def _cached_memory_matrix(conn, scope: str, shared: bool = False, include_global: bool = False):
    """按 scope 缓存 active 记忆的向量矩阵，避免每次检索都重新 stack。

    写入后最多 30 秒内可能看到旧缓存；写入路径会主动清缓存，30 秒只是兜底。
    """
    cache_key = (scope, bool(shared), bool(include_global))
    hit = _matrix_cache.get(cache_key)
    if hit and (now() - hit[0]) < _MATRIX_CACHE_TTL:
        return hit[1], hit[2]
    cols = "SELECT id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,tier,source_id,source_text,source_time,subject_id,confidence,expires_at FROM memories"
    if shared or include_global:
        permitted = _granted_memory_ids(conn, scope)
        rows = conn.execute(cols + " WHERE status='active'").fetchall()
        rows = [r for r in rows if (r[3] == scope and not shared) or
                (r[0] in permitted and r[3] != scope and (shared or r[3] == 'global'))]
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
        permitted = _granted_memory_ids(conn, scope) if include_global else set()
        if row[3] != scope and not (include_global and row[3] == 'global' and row[0] in permitted):
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
            if r[3] != scope and r[0] not in permitted:
                continue
            reason = 'same_source' if source_id and str(r[11] or '') == source_id else 'same_fact'
            out.append({
                'id': r[0], 'text': r[1], 'tags': r[2], 'scope': r[3],
                'importance': r[4], 'created_at': r[5], 'last_access': r[6],
                'tier': r[10], 'source_id': r[11], 'source_time': r[13],
                'subject_id': r[14], 'confidence': r[15], 'expires_at': r[16],
                'status': 'active', 'score': 0.5, 'reason': reason,
                'shareAuthorizedFor': scope if r[3] != scope else '',
            })
            if len(out) >= limit:
                break
        return out

def search_memory(query: str, k: int = 5, scope: str | None = None, min_score: float = 0.35, shared: bool = False, exclude_scope: str | None = None, include_global: bool = False) -> list[dict]:
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
        permitted = _granted_memory_ids(conn, scope)
        scored = []
        for r, sim in zip(rows, sims):
            if (r[3] != scope and r[0] not in permitted) or (shared and (r[3] == exclude_scope or r[3] == scope)):
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
                # 旧 global 经过隐私审核或指定授权才能召回，不压过本聊天直接证据。
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
                'shareAuthorizedFor': scope if r[3] != scope else '',
                "importance": r[4], "sim": round(sim, 4), "score": round(score, 4),
                "recall": round(rp, 3), "access_count": r[8],
                'created_at': r[5],
                'evidence': {'sourceId': r[11], 'sourceText': r[12] if r[3] == scope else '', 'sourceTime': r[13] * 1000,
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
    valid_scope(scope)
    # This legacy adoption-only endpoint supplies no independent evidence.
    return {'changed': 0, 'reason': '需要新的本人原话证据；检索或采用本身不加固'}


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
                (mid,new_text,old['tags'],scope,old['importance'],ts,ts,initial_strength(scope,old['tags'],old['importance']),0,vec.tobytes(),'active',old['fact_key'],subject_id,str(source_id)[:120],replacement,ts,1,old['expires_at'],old['tier']))
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


def confirm_batch(scope, mid=None, subject_id=None, prefix='', review=None, auto_revision=None):
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
        if auto_revision is not None:
            if not mid or len(candidates) != 1:
                raise MemoryConflict('自动核对只允许单条候选')
            candidate, peers, snapshot = _confirmation_snapshot(conn, scope, mid, review, 'confirm')
            if not isinstance(auto_revision, str) or snapshot['revision'] != auto_revision or peers or snapshot['truncated']:
                raise MemoryConflict('自动核对期间事实变化或仍有不确定关系，未确认', snapshot)
            _, _, _, missing = _cached_reviews(conn, candidate, 'confirm')
            if missing is not None or not _accepted_evidence(_cached_evidence(conn, candidate, 'confirm', snapshot['revision'])):
                raise MemoryConflict('原话或历史审核尚未完整通过，未自动确认')
            if not candidate['source_text'] or len(candidate['source_text']) > 500 or not candidate['source_id'] or (candidate['expires_at'] and candidate['expires_at'] <= now()):
                raise MemoryConflict('来源不完整或事实已到期，未自动确认')
        # Capture all affected rows, including facts superseded by a confirmation.
        before = {}
        for candidate in candidates:
            _confirm_one(conn, scope, candidate['id'], before, review)
        undo = _record_confirmation(conn, scope, before)
        return {'changed': len(candidates), 'confirmed': len(candidates),
                'undo': undo}


def confirm_memory(scope, mid, resolution=None, revision=None, review=None, auto_revision=None):
    if not isinstance(mid, str) or not mid:
        raise ValueError('id is required')
    if resolution is not None:
        return resolve_confirmation(scope, mid, resolution, revision, review)
    return confirm_batch(scope, mid=mid, review=review, auto_revision=auto_revision)


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


_organize_plans = {}  # Local previews only; restart requires a fresh preview.
ORGANIZE_PAGE_SIZE = 50
ORGANIZE_TTL = 15 * 60


def _organize_decision(conn, row, grace_until):
    expired = bool(row['expires_at'] and row['expires_at'] <= now())
    faded = (row['status'] == 'active' and (now() - row['last_access']) / 86400 > MIN_AGE_DAYS
             and recall_prob(row['strength_days'], row['last_access'], row['importance']) < PRUNE_R)
    if (expired or faded) and row['tier'] == 'normal' and row['importance'] < .8:
        if now() * 1000 < grace_until:
            return {'action': 'hold', 'reason': '遗忘规则迁移保护期内，暂不建议归档'}
        return {'action': 'archive', 'reason': '已超过明确有效期' if expired else '普通、低重要记忆已低于归档线'}
    if row['status'] != 'candidate':
        return {'action': 'hold', 'reason': '未达到归档条件'}
    if expired or not row['source_text'] or len(row['source_text']) > 500 or not row['source_id']:
        return {'action': 'hold', 'reason': '已过期或原话来源不完整，保留待处理'}
    context, _, relations, missing = _cached_reviews(conn, row, 'confirm')
    readiness = _automatic_readiness(conn, row, 'confirm', context, relations, missing)
    if readiness['status'] != 'ready':
        return {'action': 'hold', 'reason': readiness['reason'] + '；本次不调用模型'}
    coverage = '选入的相关事实' if context.get('reviewScope') == 'related' else '全部现有事实'
    return {'action': 'confirm', 'reason': f'原话与{coverage}的审核已通过，可复用', 'revision': context['revision']}


def organize_preview(scope, after=''):
    if not scope:
        raise ValueError('请选择一个具体聊天')
    scope = valid_scope(scope)
    if not isinstance(after, str) or len(after) > 128:
        raise ValueError('invalid cursor')
    with _lock, db() as conn:
        conn.row_factory = sqlite3.Row
        # Keyset pagination limits semantic receipt checks to 50 per request.
        # Pending records never fade out just because they have waited.
        condition = """scope=? AND (status='candidate' OR (status='active' AND tier='normal' AND importance<0.8
            AND ((expires_at>0 AND expires_at<=?) OR (last_access<? AND
              1.0/(1.0+max(0,?-last_access)/86400.0/max(0.1,strength_days))<?))))"""
        args = (scope, now(), now()-MIN_AGE_DAYS*86400, now(), PRUNE_R)
        total = conn.execute('SELECT count(*) FROM memories WHERE '+condition, args).fetchone()[0]
        rows = conn.execute('SELECT * FROM memories WHERE '+condition+' AND id>? ORDER BY id LIMIT ?',
                            (*args, after, ORGANIZE_PAGE_SIZE+1)).fetchall()
        more = len(rows) > ORGANIZE_PAGE_SIZE
        rows = rows[:ORGANIZE_PAGE_SIZE]
        grace_until = retention_policy(conn)['graceUntil']
        items, expected = [], {}
        for row in rows:
            decision = _organize_decision(conn, row, grace_until)
            items.append({**decision, **{k: row[k] for k in ('id', 'text', 'status', 'subject_id', 'source_text', 'expires_at')}})
            expected[row['id']] = {'fingerprint': _fingerprint(row), **decision}
        for token in list(_organize_plans):
            if _organize_plans[token]['expires'] <= now():
                del _organize_plans[token]
        while len(_organize_plans) >= 16:
            del _organize_plans[next(iter(_organize_plans))]
        token = uuid.uuid4().hex
        _organize_plans[token] = {'scope': scope, 'expires': now()+ORGANIZE_TTL, 'expected': expected}
        return {'token': token, 'scope': scope, 'items': items, 'total': total,
                'next': rows[-1]['id'] if more else '', 'graceUntil': grace_until,
                'expiresAt': (now()+ORGANIZE_TTL)*1000, 'modelCalls': 0}


def organize_apply(scope, token, ids, action='recommended', acknowledge=False):
    if not scope:
        raise ValueError('请选择一个具体聊天')
    scope = valid_scope(scope)
    if action not in ('recommended', 'archive-selected') or (action == 'archive-selected' and acknowledge is not True):
        raise ValueError('主动归档前请确认：保留原文，但不再参与正常记忆检索')
    if not isinstance(token, str) or not isinstance(ids, list) or not 1 <= len(ids) <= ORGANIZE_PAGE_SIZE or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('请选择本页 1–50 条记录')
    with _lock:
        plan = _organize_plans.get(token)
        if not plan or plan['scope'] != scope or plan['expires'] <= now():
            raise MemoryConflict('预览已过期或服务已重启，请重新预览')
        if 'result' in plan:
            if set(ids) != plan['selection'] or action != plan['action']:
                raise MemoryConflict('这次预览已执行，请重新预览')
            return {**plan['result'], 'replayed': True}
        if any(i not in plan['expected'] or (action == 'recommended' and plan['expected'][i]['action'] == 'hold') for i in ids):
            raise ValueError('只能选择预览中可处理的记录')
        with db() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute('BEGIN IMMEDIATE')
            grace_until = retention_policy(conn)['graceUntil']
            before, applied, skipped = {}, [], []
            for mid in ids:
                expected = plan['expected'][mid]
                row = conn.execute('SELECT * FROM memories WHERE scope=? AND id=?', (scope, mid)).fetchone()
                if row is None or _fingerprint(row) != expected['fingerprint']:
                    skipped.append({'id': mid, 'reason': '预览后记录已变化，请重新预览'})
                    continue
                # Explicit user archiving is separate from automatic recommendations.
                # It never activates a fact or calls semantic review; the preview
                # fingerprint and transaction/undo protections still apply.
                decision = {'action': 'archive'} if action == 'archive-selected' else _organize_decision(conn, row, grace_until)
                if action == 'recommended' and (decision['action'] != expected['action'] or decision.get('revision') != expected.get('revision')):
                    skipped.append({'id': mid, 'reason': '相关事实或处理条件已变化；保留原状，请重新预览'})
                    continue
                if decision['action'] == 'confirm':
                    _confirm_one(conn, scope, mid, before)
                else:
                    before[mid] = dict(row)
                    conn.execute("UPDATE memories SET status='archived' WHERE id=? AND scope=?", (mid, scope))
                applied.append({'id': mid, 'action': decision['action']})
            undo = _record_confirmation(conn, scope, before) if before else None
            result = {'changed': len(applied), 'applied': applied, 'skipped': skipped, 'undo': undo, 'modelCalls': 0}
        _matrix_cache_clear()
        plan['selection'], plan['result'], plan['action'] = set(ids), result, action
        return result


def decay(prune: bool = True) -> dict:
    _matrix_cache_clear()
    removed = 0
    total = 0
    with _lock, db() as conn:
        policy = retention_policy(conn)
        if now() * 1000 < policy['graceUntil']:
            return {'total': 0, 'removed': 0, 'prune_r': PRUNE_R, 'graceUntil': policy['graceUntil'], 'reason': '新遗忘规则迁移保护期内，不归档现有记忆'}
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
        policy = retention_policy(conn)
        total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        scopes = conn.execute("SELECT scope, COUNT(*) FROM memories GROUP BY scope").fetchall()
        avg = conn.execute("SELECT AVG(strength_days), AVG(importance) FROM memories").fetchone()
        messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        summaries = conn.execute("SELECT COUNT(*) FROM session_summaries WHERE status='active'").fetchone()[0]
    return {
        'version': '0.10.1',
        'retentionPolicy': policy,
        'reviewScope': review_scope(),
        'capabilities': ['local-memory-organizer', 'content-retention-v2', 'combined-confirm-review', 'confirmation-relation-groups', 'auto-confirm-guard', 'source-lookup', 'transactional-confirm', 'confirmation-conflicts', 'fact-relations', 'unified-fact-review', 'paged-fact-review', 'context-window', 'event-merge'],
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
            if self.path == '/sharing/context':
                b=self._body()
                self._send(200,{'ok':True,**sharing_context(b.get('scope'),b.get('query',''),b.get('include_summaries') is True)})
            elif self.path == '/sharing/reviews':
                self._send(200,{'ok':True,**save_sharing_reviews(self._body().get('reviews'))})
            elif self.path == "/sharing":
                b = self._body()
                self._send(200, {"ok": True, **memory_sharing(b.get("scope"), b.get("id"), b.get("action", "view"), b.get("target_scope", ""), b.get("expected_hash", ""))})
            elif self.path == "/add":
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
                r = search_memory(b.get("query", ""), int(b.get("k", 5)), b.get("scope"), float(b.get('min_score', 0.35)), bool(b.get('shared', False)), b.get('exclude_scope'), bool(b.get('include_global', False)))
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
            elif self.path == '/organize/preview':
                b = self._body()
                self._send(200, {'ok': True, **organize_preview(b.get('scope'), b.get('after', ''))})
            elif self.path == '/organize/apply':
                b = self._body()
                self._send(200, {'ok': True, **organize_apply(b.get('scope'), b.get('token'), b.get('ids'), b.get('action', 'recommended'), b.get('acknowledge', False))})
            elif self.path == '/confirm/context':
                b = self._body()
                self._send(200, {'ok': True, **confirmation_context(b.get('scope'), b.get('id'), b.get('operation', 'confirm'))})
            elif self.path == '/confirm/review':
                b = self._body()
                self._send(200, {'ok': True, **save_review_page(b.get('scope'), b.get('id'), b.get('operation', 'confirm'), b.get('offset'), b.get('review'), b.get('evidenceOnly', False))})
            elif self.path == '/restore':
                b = self._body()
                self._send(200, {'ok': True, **restore_memory(b.get('scope'), b.get('id'), b.get('resolution'), b.get('revision'), b.get('review'))})
            elif self.path == '/confirm':
                b = self._body()
                self._send(200, {'ok': True, **confirm_memory(b.get('scope'), b.get('id'), b.get('resolution'), b.get('revision'), b.get('review'), b.get('autoRevision'))})
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
