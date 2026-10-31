"""Local synthetic memories only; no model calls / network / user DB."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fixtures', Path(__file__).with_name('memvec_test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
m = fixtures.m
SCOPE = 'private:10001'
DAY = 86400


class OrganizerTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.MemoryLifecycleTests(); self.f.setUp()
        self.old_now = m.now; self.at = 2000000000.; m.now = lambda: self.at
        m._organize_plans.clear()
        with m.db() as c:
            c.execute('UPDATE memory_retention_migrations SET migrated_at=?', (self.at-20*DAY,))

    def tearDown(self):
        m.now = self.old_now; self.f.tearDown()

    def add(self, text, **kw):
        return self.f.add(text, source_text=text, source_id=text, **kw)

    def approve(self, mid):
        context = m.confirmation_context(SCOPE, mid)['context']
        review = self.f.page_review(context)
        review['evidenceVerdict'] = self.f.evidence_review(mid)['evidenceVerdict']
        m.save_review_page(SCOPE, mid, 'confirm', 0, review, not context['related'])

    def test_read_only_preview_batch_archive_and_undo(self):
        a = self.add('expired active', confirmed=True, expires_at=self.at-1)
        b = self.add('expired pending', expires_at=self.at-1)
        old = {i:self.f.row(i) for i in (a,b)}
        plan = m.organize_preview(SCOPE)
        self.assertEqual(plan['modelCalls'], 0)
        self.assertEqual({r['action'] for r in plan['items']}, {'archive'})
        self.assertEqual(old, {i:self.f.row(i) for i in old})
        result = m.organize_apply(SCOPE, plan['token'], [a,b])
        self.assertEqual(result['changed'],2)
        self.assertEqual(result['modelCalls'],0)
        replay = m.organize_apply(SCOPE,plan['token'],[a,b])
        self.assertTrue(replay['replayed']); self.assertEqual(result['undo'],replay['undo'])
        m.undo_confirm(SCOPE,result['undo']['operationId'])
        self.assertEqual(old,{i:self.f.row(i) for i in old})

    def test_faded_pending_core_task_high_importance_stay(self):
        pending = self.add('old pending')
        normal = self.add('old ordinary',confirmed=True)
        core = self.add('core',confirmed=True,tier='core')
        task = self.add('task',confirmed=True,tier='task')
        high = self.add('important',confirmed=True,importance=.9)
        with m.db() as c: c.execute('UPDATE memories SET last_access=?,strength_days=1',(self.at-100*DAY,))
        plan=m.organize_preview(SCOPE); items={r['id']:r for r in plan['items']}
        self.assertEqual(items[pending]['action'],'hold')
        self.assertEqual(items[normal]['action'],'archive')
        for mid in (core,task,high): self.assertNotIn(mid,items)
        with self.assertRaises(ValueError):m.organize_apply(SCOPE,plan['token'],[pending])

    def test_grace_preserved_and_not_bypassed_at_apply(self):
        mid=self.add('old',confirmed=True,expires_at=self.at-1)
        plan=m.organize_preview(SCOPE)
        with m.db() as c:c.execute('UPDATE memory_retention_migrations SET migrated_at=?',(self.at,))
        result=m.organize_apply(SCOPE,plan['token'],[mid])
        self.assertEqual(result['changed'],0);self.assertEqual(len(result['skipped']),1)
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')

    def test_approved_candidate_reuses_strict_receipts(self):
        mid=self.add('independent fact');self.approve(mid)
        plan=m.organize_preview(SCOPE)
        self.assertEqual(plan['items'][0]['action'],'confirm')
        result=m.organize_apply(SCOPE,plan['token'],[mid])
        self.assertEqual(result['changed'],1);self.assertEqual(self.f.row(mid)['status'],'active')
        m.undo_confirm(SCOPE,result['undo']['operationId'])
        self.assertEqual(self.f.row(mid)['status'],'candidate')

    def test_later_candidate_cannot_ignore_newly_confirmed_fact(self):
        a=self.add('A');b=self.add('B');self.approve(a);self.approve(b)
        plan=m.organize_preview(SCOPE)
        self.assertEqual([r['action'] for r in plan['items']],['confirm','confirm'])
        result=m.organize_apply(SCOPE,plan['token'],[a,b])
        self.assertEqual(result['changed'],1);self.assertEqual(result['skipped'][0]['id'],b)
        self.assertEqual(self.f.row(b)['status'],'candidate')

    def test_new_fact_after_preview_or_changed_source_skips(self):
        mid=self.add('candidate');self.approve(mid);plan=m.organize_preview(SCOPE)
        self.add('newly confirmed',confirmed=True)
        self.assertEqual(m.organize_apply(SCOPE,plan['token'],[mid])['changed'],0)
        archived=self.add('expired',expires_at=self.at-1);plan=m.organize_preview(SCOPE)
        with m.db() as c:c.execute('UPDATE memories SET source_text=? WHERE id=?',('corrected',archived))
        self.assertEqual(m.organize_apply(SCOPE,plan['token'],[archived])['changed'],0)

    def test_missing_rejected_and_conflicting_review_never_confirm(self):
        old=self.add('old fact',confirmed=True)
        mid=self.add('pending fact')
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')
        self.f.store_evidence(mid,False)
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')
        ctx=m.confirmation_context(SCOPE,mid)['context'];review=self.f.page_review(ctx,old)
        review['evidenceVerdict']=self.f.evidence_review(mid)['evidenceVerdict']
        m.save_review_page(SCOPE,mid,'confirm',0,review)
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')

    def test_scope_selection_expiry_and_restart(self):
        mid=self.add('expired',expires_at=self.at-1);plan=m.organize_preview(SCOPE)
        with self.assertRaises(m.MemoryConflict):m.organize_apply('group:2',plan['token'],[mid])
        with self.assertRaises(ValueError):m.organize_apply(SCOPE,plan['token'],['unknown'])
        with self.assertRaises(ValueError):m.organize_apply(SCOPE,plan['token'],[mid,mid])
        with self.assertRaises(ValueError):m.organize_preview(None)
        self.at+=901
        with self.assertRaises(m.MemoryConflict):m.organize_apply(SCOPE,plan['token'],[mid])
        plan=m.organize_preview(SCOPE);m._organize_plans.clear()
        with self.assertRaises(m.MemoryConflict):m.organize_apply(SCOPE,plan['token'],[mid])

    def test_pagination_and_bounded_preview_storage(self):
        for i in range(55):self.add('pending '+str(i),expires_at=self.at-1)
        one=m.organize_preview(SCOPE);two=m.organize_preview(SCOPE,one['next'])
        self.assertEqual((one['total'],len(one['items']),len(two['items'])),(55,50,5))
        self.assertFalse(set(r['id'] for r in one['items']) & set(r['id'] for r in two['items']))
        for i in range(20):m.organize_preview('group:2')
        self.assertEqual(len(m._organize_plans),16)

    def test_undo_refuses_later_edits(self):
        mid=self.add('expired',expires_at=self.at-1);plan=m.organize_preview(SCOPE)
        result=m.organize_apply(SCOPE,plan['token'],[mid])
        with m.db() as c:c.execute('UPDATE memories SET text=? WHERE id=?',('edited',mid))
        with self.assertRaises(m.MemoryConflict):m.undo_confirm(SCOPE,result['undo']['operationId'])

    def test_transaction_failure_rolls_back_and_plan_can_retry(self):
        mid=self.add('expired',expires_at=self.at-1);plan=m.organize_preview(SCOPE)
        original=m._record_confirmation
        def fail(*args):raise RuntimeError('journal unavailable')
        m._record_confirmation=fail
        try:
            with self.assertRaises(RuntimeError):m.organize_apply(SCOPE,plan['token'],[mid])
            self.assertEqual(self.f.row(mid)['status'],'candidate')
        finally:m._record_confirmation=original
        self.assertEqual(m.organize_apply(SCOPE,plan['token'],[mid])['changed'],1)

    def test_source_only_review_cannot_skip_historical_facts(self):
        self.add('history',confirmed=True)
        mid=self.add('pending');self.f.store_evidence(mid)
        self.assertEqual(m.organize_preview(SCOPE)['items'][0]['action'],'hold')


    def test_manual_archive_unreviewed_during_grace_is_explicit_free_and_undoable(self):
        mid=self.add('unreviewed fact')
        with m.db() as c:c.execute('UPDATE memory_retention_migrations SET migrated_at=?',(self.at,))
        plan=m.organize_preview(SCOPE);before=self.f.row(mid)
        self.assertEqual(plan['items'][0]['action'],'hold')
        with self.assertRaises(ValueError):m.organize_apply(SCOPE,plan['token'],[mid])
        with self.assertRaises(ValueError):m.organize_apply(SCOPE,plan['token'],[mid],'archive-selected')
        original=m._organize_decision
        def fail(*args):raise AssertionError('Manual archive must not review semantics')
        m._organize_decision=fail
        try:result=m.organize_apply(SCOPE,plan['token'],[mid],'archive-selected',True)
        finally:m._organize_decision=original
        self.assertEqual(result['modelCalls'],0);self.assertEqual(result['changed'],1)
        self.assertEqual(self.f.row(mid)['status'],'archived')
        self.assertTrue(m.organize_apply(SCOPE,plan['token'],[mid],'archive-selected',True)['replayed'])
        with self.assertRaises(m.MemoryConflict):m.organize_apply(SCOPE,plan['token'],[mid])
        m.undo_confirm(SCOPE,result['undo']['operationId'])
        self.assertEqual(self.f.row(mid),before)

    def test_manual_archive_never_accepts_unpreviewed_or_changed_rows(self):
        mid=self.add('pending');other=self.add('other chat',scope='group:2')
        plan=m.organize_preview(SCOPE)
        with self.assertRaises(ValueError):m.organize_apply(SCOPE,plan['token'],[other],'archive-selected',True)
        with m.db() as c:c.execute('UPDATE memories SET text=? WHERE id=?',('corrected',mid))
        result=m.organize_apply(SCOPE,plan['token'],[mid],'archive-selected',True)
        self.assertEqual(result['changed'],0);self.assertEqual(len(result['skipped']),1)
        self.assertEqual(self.f.row(mid)['status'],'candidate')


if __name__ == '__main__':unittest.main()
