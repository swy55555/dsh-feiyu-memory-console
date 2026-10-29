"""No model downloads: deterministic vectors isolate memory lifecycle behavior."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('memory_server', Path(__file__).resolve().parents[1] / 'memvec/server.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MemoryLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='feiyu-regression-')
        m.DB_PATH = str(Path(self.tmp.name) / 'memories.db')
        m._owner_scope_cache = 'private:10001'
        m._strength_migrated = False
        m.embed = lambda texts: np.array([[1., 0., 0.] for _ in texts], dtype=np.float32)
        # 这些用例比较生命周期/排序，不是去重；用相同模拟向量时关掉相似去重。
        m.DEDUPE_SIM = 1.01

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, text, scope='private:10001', subject='10001', **kwargs):
        return m.add_memory(text, scope=scope, subject_id=subject, **kwargs)['id']

    def row(self, mid):
        with m.db() as c:
            c.row_factory = m.sqlite3.Row
            return dict(c.execute('SELECT * FROM memories WHERE id=?', (mid,)).fetchone())

    def pair(self, **kwargs):
        old = self.add('old fact', fact_key='preference', confirmed=True, source_time=m.now()-100, **kwargs)
        new = self.add('new fact', fact_key='preference', source_time=m.now(), **kwargs)
        return old, new

    def test_batch_only_confirms_sender(self):
        a = self.add('A', scope='group:1', subject='111')
        b = self.add('B', scope='group:1', subject='222')
        other = self.add('A elsewhere', scope='group:2', subject='111')
        result = m.manage_memory('group:1', '111', 'confirm')
        self.assertEqual(result['changed'], 1)
        self.assertEqual(self.row(a)['status'], 'active')
        self.assertEqual(self.row(b)['status'], 'candidate')
        self.assertEqual(self.row(other)['status'], 'candidate')

    def test_prefix_is_literal_not_sql_wildcard(self):
        a = self.add('candidate')
        self.assertEqual(m.manage_memory('private:10001', '10001', 'confirm', query='%')['changed'], 0)
        self.assertEqual(self.row(a)['status'], 'candidate')

    def test_confirm_and_undo_restore_every_row(self):
        old, new = self.pair(tier='core')
        before = [self.row(old), self.row(new)]
        result = m.confirm_memory('private:10001', new)
        self.assertEqual(self.row(old)['status'], 'superseded')
        self.assertEqual(self.row(new)['status'], 'active')
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual([self.row(old), self.row(new)], before)

    def test_related_core_inheritance_is_reversible(self):
        source_time = m.now()-100
        old = self.add('core old', confirmed=True, tier='core', source_time=source_time, source_id='original-message')
        priority = m.priority_memories('private:10001', '10001')
        self.assertEqual(priority[0]['evidence'], {'sourceId': 'original-message', 'subjectId': '10001', 'sourceTime': source_time * 1000})
        self.assertEqual(priority[0]['scope'], 'private:10001')
        self.assertEqual(m.priority_memories('private:10001', '222'), [])
        new = self.add('related candidate', semantic_checked=True, relation='conflict', related_id=old,
                       source_time=m.now(), expires_at=m.now()+5000)
        before = self.row(new)
        result = m.confirm_memory('private:10001', new)
        self.assertEqual(self.row(new)['tier'], 'core')
        self.assertEqual(self.row(new)['expires_at'], 0)
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(new), before)
        self.assertEqual(self.row(old)['status'], 'active')

    def test_undo_refuses_later_changes_without_partial_restore(self):
        old, new = self.pair()
        result = m.confirm_memory('private:10001', new)
        with m.db() as c:
            c.execute('UPDATE memories SET importance=.9 WHERE id=?', (new,))
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(old)['status'], 'superseded')
        self.assertEqual(self.row(new)['status'], 'active')

    def test_undo_refuses_new_conflicting_fact(self):
        old, new = self.pair()
        result = m.confirm_memory('private:10001', new)
        later = self.add('later', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET fact_key='preference' WHERE id=?", (later,))
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(old)['status'], 'superseded')

    def test_batch_conflict_rolls_back_all_candidates(self):
        first = self.add('first candidate', source_time=m.now()-200)
        old = self.add('stale candidate', fact_key='p', source_time=m.now()-100)
        active = self.add('newer fact', fact_key='p', confirmed=True, source_time=m.now())
        with self.assertRaises(m.MemoryConflict):
            m.manage_memory('private:10001', '10001', 'confirm')
        self.assertEqual(self.row(first)['status'], 'candidate')
        self.assertEqual(self.row(old)['status'], 'candidate')
        self.assertEqual(self.row(active)['status'], 'active')
        with m.db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM memory_operations').fetchone()[0], 0)

    def test_operation_survives_reopening_and_is_single_use(self):
        _, new = self.pair()
        op = m.confirm_memory('private:10001', new)['undo']['operationId']
        # Each call opens a fresh SQLite connection; undo depends on disk state.
        m.undo_confirm('private:10001', op)
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('private:10001', op)

    def test_noop_produces_no_undo_recipe(self):
        active = self.add('already active', confirmed=True)
        result = m.confirm_memory('private:10001', active)
        self.assertEqual(result['changed'], 0)
        self.assertNotIn('undo', result)

    def test_wrong_scope_cannot_undo(self):
        _, new = self.pair()
        op = m.confirm_memory('private:10001', new)['undo']['operationId']
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('group:999', op)

    def test_journal_failure_rolls_back_confirmation(self):
        old, new = self.pair()
        with m.db() as c:
            c.execute("CREATE TRIGGER reject_operation BEFORE INSERT ON memory_operations BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(m.sqlite3.IntegrityError):
            m.confirm_memory('private:10001', new)
        self.assertEqual(self.row(old)['status'], 'active')
        self.assertEqual(self.row(new)['status'], 'candidate')

    def test_search_includes_global_filters_status_expiry_and_preserves_state(self):
        active = self.add('active', confirmed=True, source_text='original wording', source_id='msg1')
        self.add('candidate')
        self.add('expired', confirmed=True, expires_at=m.now()-10)
        self.add('other scope', scope='group:1', confirmed=True)
        legacy = self.add('legacy global', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET scope='global' WHERE id=?", (legacy,))
        before = self.row(active)
        result = m.search_memory('question', scope='private:10001')
        self.assertEqual({r['id'] for r in result}, {active, legacy})
        self.assertEqual(self.row(active), before)
        evidence = result[0]['retrieval']
        self.assertAlmostEqual(evidence['score'], evidence['similarity'] * evidence['retentionMultiplier'] * evidence['importanceFactor'])

    def test_search_ranks_importance_after_relevance_and_recency(self):
        low = self.add('low importance fact', confirmed=True, importance=0.2)
        high = self.add('high importance fact', confirmed=True, importance=1.0)
        result = m.search_memory('fact', scope='private:10001')
        ids = [r['id'] for r in result]
        self.assertLess(ids.index(high), ids.index(low))
        high_row = next(r for r in result if r['id'] == high)
        low_row = next(r for r in result if r['id'] == low)
        self.assertAlmostEqual(high_row['retrieval']['importanceFactor'], 1.25)
        self.assertAlmostEqual(low_row['retrieval']['importanceFactor'], 0.85)

    def test_association_fact_source_both_and_expiry(self):
        for fact, source in [('preference', ''), ('', 'message-1'), ('preference', 'message-1')]:
            with self.subTest(fact=fact, source=source):
                with m.db() as c:
                    c.execute('DELETE FROM memories')
                seed = self.add('seed', confirmed=True)
                peer = self.add('peer', confirmed=True)
                expired = self.add('expired', confirmed=True)
                with m.db() as c:
                    c.execute('UPDATE memories SET fact_key=?, source_id=?', (fact, source))
                    c.execute('UPDATE memories SET expires_at=? WHERE id=?', (m.now()-1, expired))
                rows = m.associate_memory(seed, 'private:10001')
                self.assertEqual([r['id'] for r in rows], [peer])

    def test_association_seed_scope_global_toggle_and_limit(self):
        seed = self.add('seed', scope='group:1', confirmed=True)
        local = self.add('local', scope='group:1', confirmed=True)
        shared = self.add('public shared', scope='group:1', confirmed=True)
        foreign = self.add('foreign', scope='group:2', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET source_id='same'")
            c.execute("UPDATE memories SET scope='global' WHERE id=?", (shared,))
        self.assertEqual([r['id'] for r in m.associate_memory(seed, 'group:1')], [local])
        self.assertEqual(set(r['id'] for r in m.associate_memory(seed, 'group:1', 99, True)), {local, shared})
        self.assertEqual(m.associate_memory(foreign, 'group:1'), [])
        self.assertEqual(m.associate_memory(shared, 'group:1'), [])
        with m.db() as c:
            c.execute('UPDATE memories SET expires_at=? WHERE id=?', (m.now()-1, seed))
        self.assertEqual(m.associate_memory(seed, 'group:1'), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
