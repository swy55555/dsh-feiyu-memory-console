"""Synthetic DB, deterministic embeddings, no model or live service."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fixtures', Path(__file__).with_name('memvec_test.py'))
fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
m = fixtures.m
SCOPE = 'private:10001'


class ExperienceTests(unittest.TestCase):
    def test_whole_preference_habit_and_plan_are_references_not_confirmed_facts(self):
        for tag, quote in [('preference', '我不吃煎饼'), ('habit', '我只在周末喝咖啡'), ('plan', '我明天打算去看电影')]:
            r = self.episode(tags=tag, quote=quote, source_id='ref-'+tag, raw=False)
            self.assertEqual(self.f.row(r['id'])['status'], 'candidate')
            m.add_message(SCOPE, 'ref-'+tag, '用户', '10001', quote, at=self.at*1000)
            plan = m.organize_preview(SCOPE)
            out = m.organize_apply(SCOPE, plan['token'], [r['id']])
            self.assertEqual(out['modelCalls'], 0)
            stored = self.f.row(r['id'])
            self.assertEqual((stored['status'], stored['memory_kind'], stored['confidence']), ('active', 'experience', 0))
            self.assertEqual(stored['source_text'], quote)
            self.assertEqual(m.related_memories(SCOPE, '10001', quote), [])

    def test_partial_quote_cannot_drop_qualification_and_become_active(self):
        raw = '我喜欢咖啡是别人说的，我只喝茶'
        m.add_message(SCOPE, 'msg-1', '用户', '10001', raw, at=self.at*1000)
        r = self.episode(raw=False, tags='preference', quote='我喜欢咖啡', source_text=raw)
        self.assertEqual(self.f.row(r['id'])['status'], 'candidate')
        self.assertNotEqual(m.organize_preview(SCOPE)['items'][0]['action'], 'experience')

    def test_source_reference_does_not_overwrite_a_conflicting_confirmed_fact(self):
        old = self.f.add('我喜欢咖啡', confirmed=True)
        before = self.f.row(old)
        r = self.episode(tags='preference', quote='我不喜欢咖啡')
        self.assertEqual(self.f.row(r['id'])['memory_kind'], 'experience')
        self.assertEqual(before, self.f.row(old))
        pending = self.episode(tags='preference', quote='我不喜欢咖啡', source_id='conflict', relation='conflict')
        self.assertEqual(self.f.row(pending['id'])['status'], 'candidate')

    def setUp(self):
        self.f = fixtures.MemoryLifecycleTests(); self.f.setUp()
        self.at = m.now() - 60
        m._organize_plans.clear()

    def tearDown(self):
        self.f.tearDown()

    def episode(self, raw=True, scope=SCOPE, quote='我今天去看了电影', **changes):
        props = dict(text='用户（QQ 10001）曾说：'+quote, tags='episode', scope=scope,
                     subject_id='10001',source_id='msg-1',source_text=quote,source_time=self.at,
                     memory_kind='experience',confirmed=False,tier='normal')
        props.update(changes)
        if raw:
            m.add_message(scope,'msg-1','用户','10001',quote,at=self.at*1000)
        return m.add_memory(**props)

    def test_new_experience_is_searchable_without_fact_confirmation(self):
        a=self.episode()
        row=self.f.row(a['id'])
        self.assertEqual((row['status'],row['memory_kind'],row['confidence']),('active','experience',0))
        self.assertEqual(row['expires_at'],0)
        found=m.search_memory('电影',scope=SCOPE,min_score=0)
        self.assertEqual(found[0]['memory_kind'],'experience')
        self.assertEqual(found[0]['evidence']['sourceTime'],self.at*1000)
        self.assertEqual(m.related_memories(SCOPE,'10001','电影'),[])
        candidate=self.f.add('some fact')
        self.assertEqual(m.confirmation_context(SCOPE,candidate)['context']['total'],0)

    def test_raw_source_speaker_scope_time_and_quote_are_all_required(self):
        m.add_message(SCOPE,'msg-1','用户','10001','我今天去看了电影',at=self.at*1000)
        for change in [dict(source_id='absent'),dict(subject_id='20002'),dict(scope='group:2'),
                       dict(source_time=self.at+30),dict(source_text='模型改写的摘要'),dict(text='模型推断他爱看电影')]:
            r=self.episode(raw=False,**change)
            self.assertEqual(self.f.row(r['id'])['status'],'candidate')

    def test_delayed_original_migrates_locally_and_undo_does_not_repeat(self):
        r=self.episode(raw=False)
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')
        m.add_message(SCOPE,'msg-1','用户','10001','我今天去看了电影',at=self.at*1000)
        before=self.f.row(r['id'])
        plan=m.organize_preview(SCOPE)
        self.assertEqual(plan['items'][0]['action'],'experience')
        out=m.organize_apply(SCOPE,plan['token'],[r['id']])
        self.assertEqual(out['modelCalls'],0)
        self.assertEqual(self.f.row(r['id'])['memory_kind'],'experience')
        m.undo_confirm(SCOPE,out['undo']['operationId'])
        self.assertEqual(before,self.f.row(r['id']))
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')

    def test_explicit_expiry_and_conflicts_are_not_overridden(self):
        r=self.episode(memory_kind='fact',expires_at=m.now()-1)
        plan=m.organize_preview(SCOPE)
        self.assertNotEqual(plan['items'][0]['action'],'experience')
        self.assertLess(self.f.row(r['id'])['expires_at'],m.now())
        with m.db() as c:
            c.execute("UPDATE memories SET expires_at=0,relation='conflict' WHERE id=?",(r['id'],))
        self.assertNotEqual(m.organize_preview(SCOPE)['items'][0]['action'],'experience')

    def test_replay_is_idempotent_and_deleted_experience_stays_deleted(self):
        r=self.episode();again=self.episode()
        self.assertEqual(r['id'],again['id'])
        with m.db() as c:c.execute("UPDATE memories SET status='deleted' WHERE id=?",(r['id'],))
        self.assertEqual(self.episode()['status'],'deleted')

    def test_migration_rechecks_raw_message_at_apply_and_rolls_back_without_journal(self):
        r=self.episode(memory_kind='fact');plan=m.organize_preview(SCOPE)
        with m.db() as c:c.execute("UPDATE messages SET text='更正过的原话'")
        self.assertEqual(m.organize_apply(SCOPE,plan['token'],[r['id']])['changed'],0)
        with m.db() as c:c.execute("UPDATE messages SET text='我今天去看了电影'")
        plan=m.organize_preview(SCOPE);old=m._record_confirmation
        def fail(*a):raise RuntimeError('journal failure')
        m._record_confirmation=fail
        try:
            with self.assertRaises(RuntimeError):m.organize_apply(SCOPE,plan['token'],[r['id']])
        finally:m._record_confirmation=old
        self.assertEqual(self.f.row(r['id'])['status'],'candidate')

    def test_no_cross_chat_recall_without_sharing_permission(self):
        self.episode()
        self.assertEqual(m.search_memory('电影',scope='group:2',min_score=0),[])
        self.assertEqual(m.search_memory('电影',scope='group:2',shared=True,min_score=0),[])

    def test_experience_does_not_invalidate_unrelated_fact_review(self):
        candidate=self.f.add('new fact')
        before=m.confirmation_context(SCOPE,candidate)['context']['revision']
        self.episode()
        self.assertEqual(before,m.confirmation_context(SCOPE,candidate)['context']['revision'])

    def test_retrieval_does_not_strengthen_and_consolidation_keeps_source(self):
        r=self.episode();before=self.f.row(r['id'])
        m.search_memory('电影',scope=SCOPE,min_score=0)
        m.consolidate_scope(SCOPE)
        self.assertEqual(before,self.f.row(r['id']))

    def test_restore_and_priority_preserve_experience_boundary(self):
        r=self.episode()
        for i in range(10):self.f.add('fact '+str(i),confirmed=True)
        with m.db() as c:c.execute("UPDATE memories SET status='archived' WHERE id=?",(r['id'],))
        prepared=m.confirmation_context(SCOPE,r['id'],'restore')
        self.assertFalse(prepared['needed'])
        self.assertEqual(m.restore_memory(SCOPE,r['id'])['changed'],1)
        with m.db() as c:c.execute("UPDATE memories SET tier='core' WHERE id=?",(r['id'],))
        self.assertEqual(m.priority_memories(SCOPE,'10001')[0]['memory_kind'],'experience')


if __name__ == '__main__':unittest.main()
