"""Read-only source inventory. No model, network, writes, or automatic corrections.

Only counts leave the auditor; missing sources are not classified as false memories.
"""
import argparse
import hashlib
from collections import Counter
import json
from pathlib import Path
import sqlite3


def audit(db_path, state_dir=None, owner_scope=None):
    conn = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    conn.execute('BEGIN')  # One consistent read snapshot across tables.
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'messages', 'memories'} <= tables:
            raise ValueError('Missing messages or memories table; audit not performed')
        sources, event_sources, record_sources = {}, {}, {}
        counts = Counter()
        raw_rows = [dict(r) for r in conn.execute('SELECT * FROM messages')]
        live_ids = {r.get('id') for r in raw_rows if r.get('id')}
        archive_rows = [dict(r) for r in conn.execute('SELECT * FROM evidence_sources')] if 'evidence_sources' in tables else []
        for r in raw_rows:
            counts[r['key']] += 1
        for raw in [*raw_rows, *(r for r in archive_rows if r['id'] not in live_ids)]:
            r = dict(raw)
            if r['message_id']:
                sources.setdefault((r['key'], str(r['message_id'])), []).append(r)
                event_id = hashlib.sha256((r['key'] + '/' + str(r['message_id'])).encode()).hexdigest()[:24]
                event_sources.setdefault((r['key'], event_id), []).append(r)
            if r.get('id'):
                record_sources[(r['key'], str(r['id']))] = r

        def classify(scope, mid, speaker, quote, complete=False, at=None, namespace='message'):
            if not scope or not mid or not speaker or not quote:
                return 'incomplete_reference'
            index = event_sources if namespace == 'continuity-event' else sources
            matches = index.get((scope, str(mid)), [])
            if not matches:
                return 'raw_unavailable'
            if len(matches) != 1:
                return 'ambiguous_source_id'
            src = matches[0]
            if str(src['user_id']) != str(speaker) or src['is_self']:
                return 'speaker_or_author_mismatch'
            if (src['text'] != quote if complete else quote not in src['text']):
                return 'text_mismatch'
            if at is not None and abs(float(src['at']) - float(at)) > 1000:
                return 'time_mismatch'
            return 'full_source_matches' if complete else 'quote_found_not_full_validation'

        memory = Counter()
        for raw in conn.execute("SELECT * FROM memories WHERE status IN ('active','candidate')"):
            r = dict(raw)
            mid = str(r.get('source_id') or '')
            if mid.startswith(('console-', 'persona-', 'diary:')):
                memory['non_chat_origin'] += 1
                continue
            at = (float(r['source_time']) * 1000) if r.get('source_time') else None
            memory[classify(r['scope'], mid, r.get('subject_id'), r.get('source_text'), True, at)] += 1

        summary = Counter()
        if 'session_summaries' in tables:
            for r in conn.execute("SELECT key,covered_ids FROM session_summaries WHERE status='active'"):
                try:
                    ids = json.loads(r['covered_ids'])
                    if not isinstance(ids, list):
                        raise ValueError()
                except (ValueError, TypeError):
                    summary['invalid_coverage'] += 1
                    continue
                if not ids:
                    summary['no_coverage_ids'] += 1
                    continue
                missing = sum((r['key'], str(mid)) not in record_sources for mid in ids)
                summary['some_raw_unavailable' if missing else 'all_ids_present_not_semantic_validation'] += 1

        bridge = {}
        if state_dir:
            def read(name):
                file = Path(state_dir) / name
                if not file.exists():
                    return None
                try:
                    return json.loads(file.read_text(encoding='utf-8-sig'))
                except (ValueError, OSError):
                    bridge[name] = {'unreadable': 1}
                    return None

            def count_evidence(name, scope, items, id_field='id'):
                result = bridge.setdefault(name, Counter())
                speaker = scope[8:] if isinstance(scope, str) and scope.startswith('private:') else None
                for e in items:
                    if not isinstance(e, dict):
                        result['invalid_reference'] += 1
                        continue
                    # Bridge evidence uses hash(chat/messageId), not the raw QQ ID.
                    # Its timestamp is analysis time, not necessarily message arrival.
                    result[classify(scope, e.get(id_field), speaker, e.get('quote'), namespace='continuity-event')] += 1

            for file, categories in [('continuity.json', ('concerns', 'beliefs')), ('response-patterns.json', ('evidence', 'adjustments'))]:
                data = read(file)
                if not isinstance(data, dict):
                    continue
                for entry in data.get('chats', []):
                    if not isinstance(entry, list) or len(entry) != 2 or not isinstance(entry[1], dict):
                        bridge.setdefault(file, Counter())['invalid_chat_shape'] += 1
                        continue
                    scope, state = entry
                    for kind in categories:
                        for item in state.get(kind, []):
                            refs = item.get('evidence', []) if file == 'continuity.json' else [item]
                            count_evidence(file + ':' + kind, scope, refs, 'id' if file == 'continuity.json' else 'sourceId')
            data = read('self-reference.json')
            if isinstance(data, dict):
                for claim in data.get('claims', []):
                    count_evidence('self-reference.json:claims', owner_scope, claim.get('evidence', []))

        return {'readOnly': True, 'modelCalls': 0, 'snapshot': 'database transaction; bridge files sampled separately',
                'rawWindow': {'chats': len(counts), 'messages': sum(counts.values()), 'largestChat': max(counts.values(), default=0),
                              'chatsAt5000': sum(n >= 5000 for n in counts.values())},
                'retainedOriginals':len(archive_rows), 'memorySources': dict(memory), 'summaryCoverage': dict(summary),
                'bridgeEvidence': {k: dict(v) for k, v in bridge.items()},
                'limits': ['Unavailable raw text does not prove a memory false.',
                           'A matched quote does not establish its meaning or independent evidence.',
                           'Nested historical revisions, feelings and classroom derivations are not inventoried in this audit.']}
    finally:
        conn.rollback()
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--state-dir')
    parser.add_argument('--owner-scope')
    args = parser.parse_args()
    print(json.dumps(audit(args.db, args.state_dir, args.owner_scope), ensure_ascii=True, indent=2))
