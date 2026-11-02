"""Rebuildable original-source index and transactional, body-free change log.

Uses surviving originals only. No model calls, new dependencies or retention grants.
All writes, including console SQLite writes, maintain the index using SQL triggers.
"""
import json
import re
import math
import time
import importlib.util
from pathlib import Path
_spec=importlib.util.spec_from_file_location("scoped_lexical",Path(__file__).with_name("lexical_rank.py"))
_lex=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_lex)
from datetime import datetime, timedelta, timezone

SCHEMA = 2
TOKENIZER = 'trigram'


def install(conn, rebuild=False):
    exists=conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_index_meta'").fetchone()
    if exists and not rebuild and conn.execute('SELECT 1 FROM evidence_index_meta WHERE version=?',(SCHEMA,)).fetchone():
        return
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')
    conn.execute('CREATE TABLE IF NOT EXISTS evidence_index_meta(version INTEGER PRIMARY KEY, tokenizer TEXT NOT NULL)')
    if not rebuild and conn.execute('SELECT 1 FROM evidence_index_meta WHERE version=?', (SCHEMA,)).fetchone():
        return
    # Caller owns the transaction. DDL and backfill roll back together on interruption.
    conn.execute("CREATE TABLE IF NOT EXISTS evidence_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, source_version TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, at REAL NOT NULL, message_id TEXT NOT NULL DEFAULT '', speaker TEXT NOT NULL DEFAULT '')")
    columns = {r[1] for r in conn.execute('PRAGMA table_info(evidence_changes)')}
    for column in ('message_id', 'speaker'):
        if column not in columns:
            conn.execute(f"ALTER TABLE evidence_changes ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    conn.execute('CREATE INDEX IF NOT EXISTS evidence_changes_scope ON evidence_changes(scope,sequence)')
    conn.execute('CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(source_version UNINDEXED, scope UNINDEXED, text, tokenize="trigram")')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_messages_source_version ON messages(source_version)')
    conn.execute('CREATE TABLE IF NOT EXISTS evidence_vectors(source_version TEXT PRIMARY KEY,model TEXT NOT NULL,dimensions INTEGER NOT NULL,embedding BLOB NOT NULL)')
    for table in ('messages', 'evidence_sources'):
        for op in ('INSERT', 'UPDATE', 'DELETE'):
            trigger = 'search_' + table + '_' + op.lower()
            conn.execute('DROP TRIGGER IF EXISTS ' + trigger)
            cleanup = '' if op == 'INSERT' else '''DELETE FROM evidence_fts WHERE source_version=OLD.source_version
                AND NOT EXISTS(SELECT 1 FROM evidence_source_lookup s WHERE s.source_version=OLD.source_version);
                DELETE FROM evidence_vectors WHERE source_version=OLD.source_version
                AND NOT EXISTS(SELECT 1 FROM evidence_source_lookup s WHERE s.source_version=OLD.source_version);'''
            insert = '' if op == 'DELETE' else '''INSERT INTO evidence_fts(source_version,scope,text)
                SELECT NEW.source_version,NEW.key,NEW.text WHERE length(NEW.source_version)=64
                AND NOT EXISTS(SELECT 1 FROM evidence_fts WHERE source_version=NEW.source_version);'''
            ref = 'OLD' if op == 'DELETE' else 'NEW'
            kind = 'source-removed' if op == 'DELETE' else 'source-changed'
            previous = f"INSERT INTO evidence_changes(scope,source_version,event_id,kind,at,message_id,speaker) SELECT OLD.key,OLD.source_version,OLD.event_id,'source-removed',unixepoch(),OLD.message_id,OLD.user_id WHERE OLD.source_version<>NEW.source_version;" if op == 'UPDATE' else ''
            conn.execute(f'''CREATE TRIGGER {trigger} AFTER {op} ON {table} BEGIN {cleanup} {insert}
                {previous}
                INSERT INTO evidence_changes(scope,source_version,event_id,kind,at,message_id,speaker)
                VALUES({ref}.key,{ref}.source_version,{ref}.event_id,'{kind}',unixepoch(),{ref}.message_id,{ref}.user_id); END''')
    for table, scope, version, event in (
        ('source_corrections', 'scope', 'source_version', 'event_id'),
        ('memories', 'scope', "''", 'id'),
        ('memory_share_grants', 'target_scope', "''", 'memory_id'),
        ('sharing_blocks', 'target_scope', "''", 'memory_id'),
    ):
        for op in ('INSERT', 'UPDATE', 'DELETE'):
            name = 'changes_' + table + '_' + op.lower()
            conn.execute('DROP TRIGGER IF EXISTS ' + name)
            r = 'OLD' if op == 'DELETE' else 'NEW'
            v = "''" if version == "''" else r + '.' + version
            message = r+'.message_id' if table=='source_corrections' else "''"
            speaker = r+'.subject' if table=='source_corrections' else "''"
            conn.execute(f'''CREATE TRIGGER {name} AFTER {op} ON {table} BEGIN
                INSERT INTO evidence_changes(scope,source_version,event_id,kind,at,message_id,speaker)
                VALUES({r}.{scope},{v},{r}.{event},'{table}-{op.lower()}',unixepoch(),{message},{speaker}); END''')
    conn.execute('DELETE FROM evidence_fts')
    conn.execute('''INSERT INTO evidence_fts(source_version,scope,text)
        SELECT source_version,key,text FROM evidence_source_lookup WHERE length(source_version)=64 GROUP BY source_version''')
    conn.execute('INSERT OR REPLACE INTO evidence_index_meta VALUES(?,?)', (SCHEMA, TOKENIZER))


def revision(conn):
    return conn.execute('SELECT coalesce(max(sequence),0) FROM evidence_changes').fetchone()[0]


def changes(conn, after=0, limit=100):
    if type(after) is not int or after < 0:
        raise ValueError('invalid change cursor')
    rows = conn.execute('SELECT sequence,scope,source_version,event_id,kind,at,message_id,speaker FROM evidence_changes WHERE sequence>? ORDER BY sequence LIMIT ?', (after, max(1, min(200, int(limit))))).fetchall()
    return {'events': [dict(zip(('sequence','scope','sourceVersion','eventId','kind','at','messageId','speaker'), r)) for r in rows], 'revision': revision(conn)}


def terms(query):
    # Chinese bigrams support short words; long Latin words remain intact. Never
    # accept caller-supplied FTS syntax, SQL identifiers or regular expressions.
    result = []
    for part in re.findall(r'[\u3400-\u9fff]+|[\w]+', query.lower()):
        if re.search(r'[\u3400-\u9fff]', part):
            result.extend(part[i:i+2] for i in range(len(part)-1))
            if len(part) >= 3:
                result.append(part)
        elif len(part) >= 2 and part not in {'what','when','where','which','does','have','with','that','this','the','you','did','was','and','are'}:
            result.append(part)
    return list(dict.fromkeys(result))[:32]


def temporal_query(query, at=None):
    """Only explicit dates or relative days; no invented event/plan dates."""
    if at is not None and (not isinstance(at,(int,float)) or not math.isfinite(at) or at <= 0):
        raise ValueError('invalid query time')
    now = datetime.fromtimestamp((at or datetime.now().timestamp()*1000)/1000, timezone.utc)
    m = re.search(r'(?<!\d)(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?', query)
    day = None
    if m:
        try:
            day = datetime(*map(int,m.groups()),tzinfo=timezone.utc)
        except ValueError:
            return {'basis':'unknown','reason':'invalid-calendar-date'}
    elif re.search(r'昨天|yesterday', query, re.I):
        day = now.replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(days=1)
    elif re.search(r'今天|today', query, re.I):
        day = now.replace(hour=0,minute=0,second=0,microsecond=0)
    # It is a ranking hint unless the caller explicitly supplies a typed filter.
    return {'basis':'spoken','from':day.timestamp()*1000,'to':(day+timedelta(days=1)).timestamp()*1000,'mode':'rank','timezone':'UTC'} if day else {'basis':'unknown'}


def _rows(conn, sql, params=()):
    cur = conn.execute(sql, params)
    names = [c[0] for c in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def source(conn, scope, version):
    if not isinstance(version,str) or not re.fullmatch('[a-f0-9]{64}',version):
        return None
    found = _rows(conn, '''SELECT s.* FROM evidence_source_lookup s WHERE s.key=? AND s.source_version=?
        AND s.source_truncated=0 AND NOT EXISTS(SELECT 1 FROM source_corrections c
        WHERE c.source_version=s.source_version AND c.state='revoked') LIMIT 1''', (scope,version))
    return found[0] if found else None


def contract(row):
    version = row['source_version']
    return {'id':'source:'+version,'text':row['text'],'scope':row['key'],
        'subject_id':row['user_id'],'memory_kind':'utterance','status':'observed',
        'source_id':row['message_id'],'source_text':row['text'],'source_time':row['at']/1000,
        'evidence':{'sourceId':row['message_id'],'sourceText':row['text'],'sourceTime':row['at'],'subjectId':row['user_id']},
        'contract':{'version':1,'sourceId':row['event_id'],'messageId':row['message_id'],'sourceVersion':version,
            'scope':row['key'],'speaker':row['user_id'],'sourceType':'character-utterance' if row['is_self'] else 'participant-utterance',
            'spokenAt':row['at'],'eventAt':None,'plannedAt':None,'recordedAt':None,
            'timeBasis':'spoken','state':'observed','moduleVersion':1,'rootIds':[version],
            'causalId':row['event_id'],'idempotencyKey':version}}


def expand(conn, scope, versions, limit=3):
    if not isinstance(versions,list) or len(versions)>3:
        raise ValueError('at most three anchors')
    result, seen = [], set()
    for version in versions:
        anchor = source(conn,scope,version)
        if not anchor:
            continue
        # Around the exact source, in the same conversation, with deterministic order.
        neighbours = _rows(conn, '''SELECT * FROM evidence_source_lookup WHERE key=? AND at BETWEEN ? AND ?
            ORDER BY abs(at-?),at,source_version LIMIT 7''', (scope,anchor['at']-120000,anchor['at']+120000,anchor['at']))
        for row in [anchor]+neighbours:
            v=row['source_version']
            if v in seen or not source(conn,scope,v):
                continue
            seen.add(v);result.append({**contract(row),'retrieval':{'method':'source-neighbour','anchor':version}})
            if len(result)>=max(1,min(12,int(limit))):
                return result
    return result


def search(conn, scope, query, vectors=(), limit=8, subject='', at=None, time_filter=None, raw_vectors=(), valid_at=None, exclude=()):
    if not isinstance(query,str) or not 1<=len(query.strip())<=2000:
        raise ValueError('query must contain 1..2000 characters')
    ts=terms(query);hint=temporal_query(query,at);ranked={};reasons={}
    if time_filter is not None:
        if not isinstance(time_filter,dict) or time_filter.get('basis')!='spoken':
            raise ValueError('only known spoken time may be filtered; event/plan time is unknown')
        lo,hi=time_filter.get('from'),time_filter.get('to')
        if any(type(v) not in (float,int) or not math.isfinite(v) for v in (lo,hi)) or not 0<lo<hi:
            raise ValueError('invalid time window')
    if not isinstance(exclude,(list,tuple)) or len(exclude)>128 or any(not isinstance(v,str) or not re.fullmatch('[a-f0-9]{64}',v) for v in exclude):
        raise ValueError('invalid excluded source versions')
    excluded=set(exclude)
    originals=_rows(conn,"""SELECT * FROM evidence_source_lookup s WHERE key=? AND source_truncated=0
        AND (?='' OR user_id=?) AND NOT EXISTS(SELECT 1 FROM source_corrections c WHERE c.source_version=s.source_version AND c.state='revoked')""",(scope,subject,subject))
    database=conn.execute('PRAGMA database_list').fetchone()[2]
    lexical=_lex.ScopedLexical(originals,query,cache_key=(database,scope,subject))
    for version,score in lexical.candidates():
        row=source(conn,scope,version)
        if not row or (subject and row['user_id']!=subject):continue
        if time_filter and not time_filter['from']<=row['at']<time_filter['to']:continue
        value=contract(row);value.update(score=score['lexical'],retrieval={'method':'lexical-source'})
        ranked[value['id']]=value
    # Vector results are existing confirmed/experience records, never all candidates.
    # Source roots deduplicate derived restatements below without hiding their provenance.
    for row in vectors:
        if row.get('scope')!=scope or (subject and str(row.get('evidence',{}).get('subjectId',''))!=subject):
            continue
        current=_rows(conn,"SELECT * FROM memories WHERE id=? AND scope=? AND status='active' AND (expires_at=0 OR expires_at>?)",(row['id'],scope,time.time() if valid_at is None else valid_at))
        if not current:
            continue
        refs=_rows(conn,'SELECT source_version FROM evidence_links WHERE owner_kind=\'memory\' AND owner_scope=? AND owner_id=? AND current=1',(scope,row['id']))
        if any(not source(conn,scope,r['source_version']) for r in refs):
            continue
        spoken=row.get('evidence',{}).get('sourceTime') or None
        if time_filter and (spoken is None or not time_filter['from']<=spoken<time_filter['to']):
            continue
        value=dict(row);value['status']='active';value['contract']={'version':1,'scope':scope,
            'recordKind':'plan-not-known-complete' if (row.get('tier') or row.get('retrieval',{}).get('tier'))=='task' else 'past-statement',
            'sourceType':'derived-experience' if row.get('memory_kind')=='experience' else 'organized-fact',
            'speaker':row.get('evidence',{}).get('subjectId',''),'spokenAt':spoken,'eventAt':None,'plannedAt':None,
            'recordedAt':row.get('created_at',0)*1000,'state':'active','moduleVersion':1,
            'rootIds':[r['source_version'] for r in refs],'sourceVersion':'','sourceId':row.get('evidence',{}).get('sourceId',''),
            'causalId':row['id'],'idempotencyKey':row['id']}
        ranked[value['id']]=value
        # A partial derived fact must not suppress the rest of its original.
        # Prefer the complete, attributable original when collapsing shared roots.
        for ref in refs:
            original=source(conn,scope,ref['source_version'])
            if not original or (subject and original['user_id']!=subject):continue
            if time_filter and not time_filter['from']<=original['at']<time_filter['to']:continue
            raw=contract(original);old=ranked.get(raw['id'],{})
            raw['score']=max(row.get('score',0),old.get('score',0))
            raw['associationId']=row['id']
            raw['retrieval']={'method':'derived-source-expansion','similarity':max(row.get('score',0),old.get('retrieval',{}).get('similarity',0)),'via':row['id'],'prior':old.get('retrieval')}
            ranked[raw['id']]=raw
    for version,similarity in raw_vectors:
        row=source(conn,scope,version)
        if not row or similarity<.4 or (subject and row['user_id']!=subject):
            continue
        if time_filter and not time_filter['from']<=row['at']<time_filter['to']:
            continue
        value=contract(row);lex=ranked.get(value['id'])
        value['score']=max(similarity,lex.get('score',0) if lex else 0)
        if lex and lex.get('associationId'):value['associationId']=lex['associationId']
        value['retrieval']={'method':'hybrid-original' if lex else 'vector-original','similarity':max(similarity,lex.get('retrieval',{}).get('similarity',0) if lex else 0),'lexical':lex.get('retrieval') if lex else None}
        ranked[value['id']]=value
    # Fuse component scores rather than letting an unrelated cosine erase lexical
    # evidence. Speaker identity is a soft hint, never an authorization override.
    for value in ranked.values():
        c=value['contract'];version=c.get('sourceVersion','')
        info=lexical.score(version,value['text'])
        semantic=float(value.get('retrieval',{}).get('similarity',value.get('score',0) if value.get('memory_kind')!='utterance' else 0))
        value['score']=info['lexical']+.3*max(0,min(1,(semantic-.35)/.65))+.08*info['speakerMatch']
        if hint.get('from',float('inf'))<=(c.get('spokenAt') or 0)<hint.get('to',0):value['score']+=.05
        value['retrieval']={**value.get('retrieval',{}),'ranking':info,'semantic':semantic}
    for value in ranked.values():
        if value.get('memory_kind')=='utterance':continue
        originals=[ranked['source:'+v] for v in value['contract']['rootIds'] if 'source:'+v in ranked]
        if originals:value['score']=max(r['score'] for r in originals)-.000001
    selected=[];roots=set();dropped=[]
    for row in sorted(ranked.values(),key=lambda r:(-r.get('score',0),0 if r.get('memory_kind')=='utterance' else 1,r['id'])):
        rr=set(row['contract']['rootIds'])
        if rr and rr.issubset(excluded):
            dropped.append({'id':row['id'],'reason':'already-delivered'});continue
        if rr and rr.issubset(roots):
            dropped.append({'id':row['id'],'reason':'same-evidence-root'});continue
        if len(selected)>=max(1,min(12,int(limit))):
            dropped.append({'id':row['id'],'reason':'result-limit'});continue
        selected.append(row);roots.update(rr)
    return {'results':selected,'revision':revision(conn),'timeHint':hint,'trace':{'candidateCount':len(ranked),'selectedIds':[r['id'] for r in selected],'dropped':dropped},'index':{'schema':SCHEMA,'tokenizer':TOKENIZER,'rawVectorIndex':True}}
