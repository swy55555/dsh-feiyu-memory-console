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

    def confirm(self, scope, mid):
        try:
            return m.confirm_memory(scope, mid)
        except m.MemoryConflict as error:
            if not error.conflict:
                raise
            return m.confirm_memory(scope, mid, 'use-candidate', error.conflict['revision'], self.review(mid, 'conflict'))

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
        result = self.confirm('private:10001', new)
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
        result = self.confirm('private:10001', new)
        self.assertEqual(self.row(new)['tier'], 'core')
        self.assertEqual(self.row(new)['expires_at'], 0)
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(new), before)
        self.assertEqual(self.row(old)['status'], 'active')

    def test_undo_refuses_later_changes_without_partial_restore(self):
        old, new = self.pair()
        result = self.confirm('private:10001', new)
        with m.db() as c:
            c.execute('UPDATE memories SET importance=.9 WHERE id=?', (new,))
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(old)['status'], 'superseded')
        self.assertEqual(self.row(new)['status'], 'active')

    def test_undo_refuses_new_conflicting_fact(self):
        old, new = self.pair()
        result = self.confirm('private:10001', new)
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
        op = self.confirm('private:10001', new)['undo']['operationId']
        # Each call opens a fresh SQLite connection; undo depends on disk state.
        m.undo_confirm('private:10001', op)
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('private:10001', op)

    def conflict_pair(self):
        candidate = self.add('older candidate', fact_key='drink', source_time=m.now()-100, fact=self.fact('同一饮品', '旧值', 'older candidate'))
        active = self.add('newer confirmed', fact_key='drink', confirmed=True, source_time=m.now(), tier='core', fact=self.fact('同一饮品', '新值', 'newer confirmed'))
        with self.assertRaises(m.MemoryConflict) as raised:
            m.confirm_memory('private:10001', candidate)
        conflict = raised.exception.conflict
        self.assertEqual(conflict['candidate']['id'], candidate)
        self.assertEqual([r['id'] for r in conflict['confirmed']], [active])
        return candidate, active, conflict['revision']

    def review(self, mid, relation='coexist', operation='confirm'):
        context = m.confirmation_context('private:10001', mid, operation)['context']
        return {'revision': context['revision'], 'candidateEvidence': context['candidate']['quote'],
                'relations': [{'id': row['id'], 'relation': relation, 'confidence': .99, 'evidence': row['quote']}
                              for row in context['related']]}

    def fact(self, obj, value, evidence, condition='', timeframe=''):
        return {'object': obj, 'attribute': '偏好', 'value': value, 'condition': condition,
                'timeframe': timeframe, 'cardinality': 'single', 'evidence': evidence}

    def test_broad_category_never_supersedes_different_objects(self):
        a = self.add('不喜欢吃煎饼', fact_key='preference.饮食', confirmed=True,
                     fact=self.fact('煎饼', '不喜欢', '不喜欢吃煎饼'))
        b = self.add('喜欢吃小笼包', fact_key='preference.饮食', confirmed=True,
                     fact=self.fact('小笼包', '喜欢', '喜欢吃小笼包'))
        self.assertEqual(self.row(a)['status'], 'active')
        self.assertEqual(self.row(b)['status'], 'active')
        with m.db() as c:
            c.execute("UPDATE memories SET status='archived' WHERE id=?", (a,))
        with self.assertRaises(m.MemoryConflict):
            m.restore_memory('private:10001', a)
        m.restore_memory('private:10001', a, review=self.review(a, operation='restore'))
        self.assertEqual(self.row(a)['status'], 'active')

    def test_same_source_multiple_facts_are_not_deduplicated_by_category(self):
        a = self.add('不喜欢煎饼', fact_key='preference.饮食', source_id='same-message')
        b = self.add('喜欢小笼包', fact_key='preference.饮食', source_id='same-message')
        self.assertNotEqual(a, b)

    def test_semantic_review_accepts_unlisted_expressions_and_context(self):
        # Contract test with a stubbed model verdict, not a semantic-accuracy benchmark.
        for text in ['周末会吃早饭', '这座城让我想留下', '茶对我来说是续命水']:
            self.add(text, confirmed=True, fact_key='broad.category')
        candidate = self.add('工作日来不及吃早餐', fact_key='broad.category')
        review = self.review(candidate)
        result = m.confirm_memory('private:10001', candidate, review=review)
        self.assertEqual(result['changed'], 1)
        with m.db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM memories WHERE status='active'").fetchone()[0], 4)

    def test_semantic_review_requires_complete_negation_evidence(self):
        self.add('喜欢煎饼', confirmed=True)
        candidate = self.add('不喜欢煎饼')
        review = self.review(candidate)
        review['candidateEvidence'] = '喜欢煎饼'
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', candidate, review=review)
        self.assertEqual(self.row(candidate)['status'], 'candidate')

    def test_semantic_review_rejects_added_fact_and_incomplete_coverage(self):
        self.add('current fact', confirmed=True)
        candidate = self.add('candidate fact')
        review = self.review(candidate)
        self.add('new fact arrived', confirmed=True)
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', candidate, review=review)
        review = self.review(candidate)
        review['relations'].pop()
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', candidate, review=review)

    def test_same_object_opposites_require_choice_even_when_newer(self):
        a = self.add('喜欢煎饼', confirmed=True, fact=self.fact('煎饼', '喜欢', '喜欢煎饼'))
        b = self.add('不喜欢煎饼', confirmed=True, fact=self.fact('煎饼', '不喜欢', '不喜欢煎饼'))
        self.assertEqual(self.row(b)['status'], 'candidate')
        review = self.review(b, 'conflict')
        with self.assertRaises(m.MemoryConflict) as raised:
            m.confirm_memory('private:10001', b, review=review)
        m.confirm_memory('private:10001', b, 'coexist', raised.exception.conflict['revision'], review)
        self.assertEqual(self.row(a)['status'], 'active')
        self.assertEqual(self.row(b)['status'], 'active')

    def test_model_cannot_replace_a_different_object(self):
        old_fact = self.fact('煎饼', '不喜欢', '不喜欢煎饼')
        a = self.add('不喜欢煎饼', confirmed=True, fact=old_fact)
        b = self.add('现在喜欢小笼包', confirmed=True, semantic_checked=True, relation='replace',
                     related_id=a, related_time=self.row(a)['source_time'], relation_confidence=.99,
                     explicit_update=True, update_evidence='现在喜欢小笼包', related_fact=old_fact,
                     fact=self.fact('小笼包', '喜欢', '现在喜欢小笼包'))
        self.assertEqual(self.row(a)['status'], 'active')
        self.assertEqual(self.row(b)['status'], 'candidate')

    def test_unknown_category_and_new_timestamp_cannot_overwrite(self):
        a = self.add('meaning needs context', fact_key='anything', confirmed=True)
        b = self.add('another ambiguous sentence', fact_key='anything', confirmed=True)
        self.assertEqual(self.row(a)['status'], 'active')
        self.assertEqual(self.row(b)['status'], 'active')

    def test_aliases_are_not_proof_of_coexistence(self):
        a = self.add('喜欢咖啡', confirmed=True, fact=self.fact('咖啡', '喜欢', '喜欢咖啡'))
        b = self.add('不喜欢拿铁', fact=self.fact('拿铁', '不喜欢', '不喜欢拿铁'))
        self.assertEqual(m.fact_relation(self.row(a), self.row(b)), 'uncertain')
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', b)

    def test_extracted_explicit_correction_needs_review_before_replacing(self):
        fact = self.fact('咖啡', '喜欢', '喜欢咖啡')
        a = self.add('喜欢咖啡', confirmed=True, fact=fact)
        b = self.add('现在不喜欢咖啡了', confirmed=True, fact=self.fact('咖啡', '不喜欢', '现在不喜欢咖啡了'),
                     semantic_checked=True, relation='replace', related_id=a, related_time=self.row(a)['source_time'],
                     relation_confidence=.99, explicit_update=True, update_evidence='现在不喜欢咖啡了', related_fact=fact)
        self.assertEqual(self.row(a)['status'], 'active')
        self.assertEqual(self.row(b)['status'], 'candidate')
        review = self.review(b, 'replace')
        with self.assertRaises(m.MemoryConflict) as error:
            m.confirm_memory('private:10001', b, review=review)
        result = m.confirm_memory('private:10001', b, 'use-candidate', error.exception.conflict['revision'], review)
        self.assertEqual(self.row(a)['status'], 'superseded')
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(a)['status'], 'active')

    def test_restore_unknown_legacy_fact_needs_review_and_can_coexist_with_undo(self):
        a = self.add('不喜欢煎饼', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET status='archived' WHERE id=?", (a,))
        b = self.add('喜欢小笼包', confirmed=True)
        with self.assertRaises(m.MemoryConflict) as error:
            m.restore_memory('private:10001', a)
        self.assertEqual(error.exception.conflict['operation'], 'restore')
        self.assertEqual(self.row(a)['status'], 'archived')
        result = m.restore_memory('private:10001', a, review=self.review(a, operation='restore'))
        self.assertEqual(self.row(a)['status'], 'active')
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(a)['status'], 'archived')
        self.assertEqual(self.row(b)['status'], 'active')

    def test_restore_keep_current_and_stale_review(self):
        a = self.add('old fact')
        with m.db() as c:
            c.execute("UPDATE memories SET status='deleted' WHERE id=?", (a,))
        self.add('current fact', confirmed=True)
        review = self.review(a, operation='restore')
        self.add('later fact', confirmed=True)
        with self.assertRaises(m.MemoryConflict):
            m.restore_memory('private:10001', a, review=review)
        with self.assertRaises(m.MemoryConflict) as error:
            m.restore_memory('private:10001', a)
        result = m.restore_memory('private:10001', a, 'keep-confirmed', error.exception.conflict['revision'])
        self.assertEqual(result['changed'], 0)
        self.assertEqual(self.row(a)['status'], 'deleted')

    def test_restore_replace_is_transactional_and_undo_restores_both(self):
        a = self.add('old fact', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET status='archived' WHERE id=?", (a,))
        b = self.add('current fact', confirmed=True, tier='core')
        before = [self.row(a), self.row(b)]
        with self.assertRaises(m.MemoryConflict) as error:
            m.restore_memory('private:10001', a)
        result = m.restore_memory('private:10001', a, 'use-candidate', error.exception.conflict['revision'], self.review(a,'conflict',operation='restore'))
        self.assertEqual(self.row(b)['status'], 'superseded')
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual([self.row(a), self.row(b)], before)

    def page_review(self, context, conflict_id=''):
        return {'revision': context['revision'], 'candidateEvidence': context['candidate']['quote'],
                'relations': [{'id': r['id'], 'relation': 'conflict' if r['id'] == conflict_id else 'coexist',
                               'confidence': .99, 'evidence': r['quote']} for r in context['related']]}

    def test_paged_review_finds_conflict_beyond_eighth_and_resumes(self):
        for n in range(17):
            self.add(f'fact {n}', confirmed=True)
        candidate = self.add('candidate needing all pages')
        ctx = m.confirmation_context('private:10001', candidate)['context']
        self.assertEqual(len(ctx['related']), 8)
        first = m.save_review_page('private:10001', candidate, 'confirm', 0, self.page_review(ctx))
        self.assertTrue(first['pending'])
        self.assertEqual(first['reviewed'], 8)
        with self.assertRaises(m.MemoryConflict) as error:
            m.confirm_memory('private:10001', candidate)
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', candidate, 'coexist', error.exception.conflict['revision'])
        second = m.confirmation_context('private:10001', candidate)
        self.assertEqual(second['context']['offset'], 8)
        conflict_id = second['context']['related'][0]['id']
        m.save_review_page('private:10001', candidate, 'confirm', 8, self.page_review(second['context'], conflict_id))
        third = m.confirmation_context('private:10001', candidate)
        self.assertEqual(third['context']['offset'], 16)
        last = m.save_review_page('private:10001', candidate, 'confirm', 16, self.page_review(third['context']))
        self.assertFalse(last['pending'])
        self.assertEqual(last['reviewed'], 17)
        with self.assertRaises(m.MemoryConflict) as error:
            m.confirm_memory('private:10001', candidate)
        self.assertFalse(error.exception.conflict['truncated'])
        self.assertEqual([r['id'] for r in error.exception.conflict['confirmed']], [conflict_id])

    def test_paged_review_cannot_reuse_old_version_or_wrong_page(self):
        for n in range(10):
            self.add(f'fact {n}', confirmed=True)
        candidate = self.add('new candidate')
        ctx = m.confirmation_context('private:10001', candidate)['context']
        review = self.page_review(ctx)
        with self.assertRaises(m.MemoryConflict):
            m.save_review_page('private:10001', candidate, 'confirm', 8, review)
        m.save_review_page('private:10001', candidate, 'confirm', 0, review)
        self.add('changed history', confirmed=True)
        reset = m.confirmation_context('private:10001', candidate)
        self.assertEqual(reset['reviewed'], 0)
        self.assertEqual(reset['context']['offset'], 0)
        with self.assertRaises(m.MemoryConflict):
            m.save_review_page('private:10001', candidate, 'confirm', 0, review)

    def test_paged_review_survives_read_counters_but_invalidates_fact_edits(self):
        for n in range(10):
            self.add(f'fact {n}', confirmed=True)
        candidate = self.add('new candidate')
        ctx = m.confirmation_context('private:10001', candidate)['context']
        m.save_review_page('private:10001', candidate, 'confirm', 0, self.page_review(ctx))
        with m.db() as c:
            c.execute('UPDATE memories SET last_access=last_access+100,access_count=access_count+1')
        resumed = m.confirmation_context('private:10001', candidate)
        self.assertEqual(resumed['reviewed'], 8)
        self.assertEqual(resumed['context']['offset'], 8)
        with m.db() as c:
            c.execute('UPDATE memories SET text=? WHERE id=?', ('changed original fact', ctx['related'][0]['id']))
        self.assertEqual(m.confirmation_context('private:10001', candidate)['reviewed'], 0)

    def test_restore_can_finish_multiple_review_pages_without_truncation(self):
        candidate = self.add('old archived record')
        with m.db() as c:
            c.execute("UPDATE memories SET status='archived' WHERE id=?", (candidate,))
        for n in range(20):
            self.add(f'current fact {n}', confirmed=True)
        count = 0
        while True:
            page = m.confirmation_context('private:10001', candidate, 'restore')
            if not page['needed']:
                break
            ctx = page['context']
            m.save_review_page('private:10001', candidate, 'restore', ctx['offset'], self.page_review(ctx))
            count += 1
        self.assertEqual(count, 3)
        result = m.restore_memory('private:10001', candidate)
        self.assertEqual(self.row(candidate)['status'], 'active')
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(candidate)['status'], 'archived')

    def test_conflict_keep_confirmed_and_undo(self):
        candidate, active, revision = self.conflict_pair()
        before = [self.row(candidate), self.row(active)]
        result = m.confirm_memory('private:10001', candidate, 'keep-confirmed', revision)
        self.assertEqual(self.row(candidate)['status'], 'archived')
        self.assertEqual(self.row(active), before[1])
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual([self.row(candidate), self.row(active)], before)

    def test_conflict_use_candidate_and_undo_preserves_core(self):
        candidate, active, revision = self.conflict_pair()
        before = [self.row(candidate), self.row(active)]
        result = m.confirm_memory('private:10001', candidate, 'use-candidate', revision)
        self.assertEqual(self.row(candidate)['status'], 'active')
        self.assertEqual(self.row(candidate)['tier'], 'core')
        self.assertEqual(self.row(active)['superseded_by'], candidate)
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual([self.row(candidate), self.row(active)], before)

    def test_conflict_resolution_rejects_stale_snapshot_and_wrong_scope(self):
        candidate, active, revision = self.conflict_pair()
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('group:1', candidate, 'use-candidate', revision)
        with m.db() as c:
            c.execute('UPDATE memories SET text=? WHERE id=?', ('changed after comparison', active))
        with self.assertRaises(m.MemoryConflict) as raised:
            m.confirm_memory('private:10001', candidate, 'use-candidate', revision)
        self.assertNotEqual(raised.exception.conflict['revision'], revision)
        self.assertEqual(self.row(candidate)['status'], 'candidate')
        self.assertEqual(self.row(active)['status'], 'active')

    def test_conflict_resolution_new_fact_invalidates_snapshot(self):
        candidate, active, revision = self.conflict_pair()
        extra = self.add('additional fact', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET fact_key='drink' WHERE id=?", (extra,))
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', candidate, 'use-candidate', revision)
        self.assertEqual(self.row(extra)['status'], 'active')
        self.assertEqual(self.row(candidate)['status'], 'candidate')

    def test_conflict_resolution_does_not_touch_other_speaker_or_chat(self):
        candidate, active, revision = self.conflict_pair()
        others = [self.add('another speaker', subject='20002', fact_key='drink', confirmed=True),
                  self.add('another chat', scope='group:1', fact_key='drink', confirmed=True)]
        before = [self.row(i) for i in others]
        m.confirm_memory('private:10001', candidate, 'use-candidate', revision)
        self.assertEqual([self.row(i) for i in others], before)

    def test_conflict_resolution_follows_replaced_related_fact(self):
        old = self.add('original related', confirmed=True, source_time=m.now()-200)
        candidate = self.add('older related candidate', semantic_checked=True, relation='conflict',
                             related_id=old, source_time=m.now()-100)
        latest = self.add('latest related', confirmed=True)
        with m.db() as c:
            c.execute("UPDATE memories SET status='superseded',superseded_by=? WHERE id=?", (latest, old))
        with self.assertRaises(m.MemoryConflict) as raised:
            m.confirm_memory('private:10001', candidate)
        self.assertEqual([r['id'] for r in raised.exception.conflict['confirmed']], [latest])
        m.confirm_memory('private:10001', candidate, 'use-candidate', raised.exception.conflict['revision'], self.review(candidate,'conflict'))
        self.assertEqual(self.row(latest)['superseded_by'], candidate)

    def test_conflict_resolution_journal_failure_rolls_back(self):
        candidate, active, revision = self.conflict_pair()
        before = [self.row(candidate), self.row(active)]
        with m.db() as c:
            c.execute("CREATE TRIGGER reject_resolution BEFORE INSERT ON memory_operations BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(m.sqlite3.IntegrityError):
            m.confirm_memory('private:10001', candidate, 'use-candidate', revision)
        self.assertEqual([self.row(candidate), self.row(active)], before)

    def test_uncertain_is_not_conflict_and_coexist_preserves_all_rows(self):
        old = [self.add(t, confirmed=True) for t in ['喜欢小笼包', '周末去散步', '喜欢猫']]
        candidate = self.add('不喜欢吃煎饼')
        review = self.review(candidate)
        for relation in review['relations']:
            relation['confidence'] = .85  # Likely coexist, but not a confident verdict.
        with self.assertRaises(m.MemoryConflict) as raised:
            m.confirm_memory('private:10001', candidate, review=review)
        snapshot = raised.exception.conflict
        self.assertEqual(snapshot['conflicts'], [])
        self.assertEqual(len(snapshot['uncertain']), 3)
        before = [self.row(i) for i in old]
        with self.assertRaises(m.MemoryConflict):
            m.confirm_memory('private:10001', candidate, 'use-candidate', snapshot['revision'], review)
        result = m.confirm_memory('private:10001', candidate, 'coexist', snapshot['revision'], review)
        self.assertEqual([self.row(i) for i in old], before)
        self.assertEqual(self.row(candidate)['status'], 'active')
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual(self.row(candidate)['status'], 'candidate')
        self.assertEqual([self.row(i) for i in old], before)

    def test_replace_only_known_conflicts_preserves_uncertain_and_equivalent(self):
        conflict = self.add('现在喝咖啡', confirmed=True)
        unknown = self.add('周末会出门', confirmed=True)
        duplicate = self.add('现在不喝咖啡', confirmed=True)
        candidate = self.add('现在不喝咖啡了')
        review = self.review(candidate)
        for item in review['relations']:
            item['relation'] = 'conflict' if item['id'] == conflict else 'uncertain' if item['id'] == unknown else 'equivalent'
        before = [self.row(i) for i in [conflict, unknown, duplicate, candidate]]
        with self.assertRaises(m.MemoryConflict) as raised:
            m.confirm_memory('private:10001', candidate, review=review)
        snapshot = raised.exception.conflict
        self.assertEqual([r['id'] for r in snapshot['conflicts']], [conflict])
        self.assertEqual([r['id'] for r in snapshot['uncertain']], [unknown])
        self.assertEqual([r['id'] for r in snapshot['duplicates']], [duplicate])
        result = m.confirm_memory('private:10001', candidate, 'use-candidate', snapshot['revision'], review)
        self.assertEqual(self.row(conflict)['status'], 'superseded')
        self.assertEqual(self.row(unknown), before[1])
        self.assertEqual(self.row(duplicate), before[2])
        m.undo_confirm('private:10001', result['undo']['operationId'])
        self.assertEqual([self.row(i) for i in [conflict,unknown,duplicate,candidate]], before)

    def test_equivalent_facts_do_not_force_a_conflict_choice(self):
        existing = self.add('喜欢小笼包', confirmed=True)
        candidate = self.add('爱吃小笼包')
        before = self.row(existing)
        result = m.confirm_memory('private:10001', candidate, review=self.review(candidate, 'equivalent'))
        self.assertEqual(result['confirmed'], 1)
        self.assertEqual(self.row(existing), before)
        self.assertEqual(self.row(candidate)['status'], 'active')

    def test_noop_produces_no_undo_recipe(self):
        active = self.add('already active', confirmed=True)
        result = m.confirm_memory('private:10001', active)
        self.assertEqual(result['changed'], 0)
        self.assertNotIn('undo', result)

    def test_wrong_scope_cannot_undo(self):
        _, new = self.pair()
        op = self.confirm('private:10001', new)['undo']['operationId']
        with self.assertRaises(m.MemoryConflict):
            m.undo_confirm('group:999', op)

    def test_journal_failure_rolls_back_confirmation(self):
        old, new = self.pair()
        with m.db() as c:
            c.execute("CREATE TRIGGER reject_operation BEFORE INSERT ON memory_operations BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(m.sqlite3.IntegrityError):
            self.confirm('private:10001', new)
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

    def test_lookup_scoped_active_sources_without_embedding(self):
        active = self.add('雨声', confirmed=True)
        foreign = self.add('别人的事实', scope='private:20002', subject='20002', confirmed=True)
        candidate = self.add('待确认')
        rows = m.lookup_memories('private:10001', [active, foreign, candidate])
        self.assertEqual([r['id'] for r in rows], [active])
        with m.db() as c:
            c.execute('UPDATE memories SET expires_at=? WHERE id=?', (m.now()-1, active))
        self.assertEqual(m.lookup_memories('private:10001', [active]), [])
        with m.db() as c:
            c.execute("UPDATE memories SET expires_at=0, status='deleted' WHERE id=?", (active,))
        self.assertEqual(m.lookup_memories('private:10001', [active]), [])
        with self.assertRaises(ValueError):
            m.lookup_memories('private:10001', [active]*4)

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
