"""Deterministic mechanism tests; no paid calls or downloads."""
import importlib.util
import json
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('fixtures',Path(__file__).with_name('memvec_test.py'))
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures);m=fixtures.m
DAY=86400

class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.MemoryLifecycleTests();self.fixture.setUp()
        self.old_now=m.now;self.at=2000000000.;m.now=lambda:self.at
    def tearDown(self):
        m.now=self.old_now;self.fixture.tearDown()
    def test_scope_equality_content_importance_and_half_time(self):
        for tags,expected in [('episode',3),('',7),('plan',7),('preference',30),('habit',30)]:
            self.assertEqual(m.initial_strength('private:10001',tags,.5),expected)
            self.assertEqual(m.initial_strength('group:9',tags,.5),expected)
            self.assertEqual(m.recall_prob(expected,self.at-expected*DAY,.5),.5)
        self.assertGreater(m.initial_strength('group:9','episode',.9),m.initial_strength('private:10001','episode',.1))
        self.assertLess(m.recall_prob(7,self.at-10000*DAY,1),.001)
        self.assertEqual(m.initial_strength('private:10001','老大，偏好',.5),30)
    def test_migration_preserves_evidence_status_expiry_and_pair_receipts(self):
        f=self.fixture
        old=f.add('old',confirmed=True,tags='habit',source_text='old original',source_id='old')
        mid=f.add('candidate',source_text='original candidate',source_id='candidate',expires_at=self.at+7*DAY)
        p=m.confirmation_context('private:10001',mid);review=f.page_review(p['context']);review['evidenceVerdict']=f.evidence_review(mid)['evidenceVerdict']
        m.save_review_page('private:10001',mid,'confirm',0,review)
        before=f.row(mid)
        with m.db() as c:
            c.execute('UPDATE memories SET strength_days=180');c.execute('DELETE FROM memory_retention_migrations')
        m._strength_migrated=False
        with m.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM memory_retention_migrations').fetchone()[0],1)
            prior=json.loads(c.execute('SELECT previous_strengths FROM memory_retention_migrations').fetchone()[0]);self.assertTrue(all(x['strength']==180 for x in prior))
        after=f.row(mid)
        for key in ('text','status','source_id','source_time','source_text','expires_at','last_access'):self.assertEqual(before[key],after[key])
        self.assertEqual(after['strength_days'],7);self.assertEqual(f.row(old)['strength_days'],30)
        self.assertEqual(m.confirmation_context('private:10001',mid)['reviewed'],1)
        self.assertFalse(m.confirmation_context('private:10001',mid)['needed'])
        with m.db() as c:c.execute('UPDATE memories SET strength_days=11 WHERE id=?',(mid,))
        m._strength_migrated=False
        self.assertEqual(f.row(mid)['strength_days'],11)
    def test_fresh_spaced_evidence_only_not_burst_replay_or_reading(self):
        f=self.fixture;mid=f.add('a fact',confirmed=True,source_id='a',source_text='a fact',source_time=self.at)
        initial=f.row(mid);self.at+=2*DAY
        f.add('a fact',confirmed=True,source_id='b',source_text='a fact',source_time=self.at)
        spaced=f.row(mid);self.assertGreater(spaced['strength_days'],initial['strength_days'])
        self.assertEqual(spaced['last_access'],self.at)
        for i in range(3):
            self.at+=60;f.add('a fact',confirmed=True,source_id='burst'+str(i),source_text='a fact',source_time=self.at)
        self.assertEqual(f.row(mid)['strength_days'],spaced['strength_days'])
        self.assertEqual(f.row(mid)['last_access'],spaced['last_access'])

        self.at+=4*DAY
        f.add('a fact',confirmed=True,source_id='b',source_text='a fact',source_time=spaced['source_time'])
        m.search_memory('a fact',scope='private:10001');m.reinforce('private:10001',[mid])
        self.assertEqual(f.row(mid)['strength_days'],spaced['strength_days'])
        self.assertEqual(f.row(mid)['last_access'],spaced['last_access'])

    def test_migration_preserves_valid_undo(self):
        f=self.fixture;mid=f.add('sole candidate')
        with m.db() as c:c.execute('UPDATE memories SET strength_days=180 WHERE id=?',(mid,))
        confirmed=m.confirm_memory('private:10001',mid)
        with m.db() as c:c.execute('DELETE FROM memory_retention_migrations')
        m._strength_migrated=False
        with m.db() as c:pass
        m.undo_confirm('private:10001',confirmed['undo']['operationId'])
        self.assertEqual(f.row(mid)['status'],'candidate')
    def test_spacing_growth_cap_wrong_subject_and_expired_evidence(self):
        f=self.fixture;mid=f.add('a fact',confirmed=True,source_id='a',source_text='a fact')
        self.at+=100*DAY
        with m.db() as c:
            self.assertFalse(m._reinforce_evidence(c,mid,'other','b',self.at,self.at))
            c.execute('UPDATE memories SET strength_days=364 WHERE id=?',(mid,))
            self.assertTrue(m._reinforce_evidence(c,mid,'10001','b',self.at,self.at))
        self.assertEqual(f.row(mid)['strength_days'],365)
        self.at+=100*DAY
        with m.db() as c:
            c.execute('UPDATE memories SET expires_at=? WHERE id=?',(self.at-1,mid))
            self.assertFalse(m._reinforce_evidence(c,mid,'10001','c',self.at,self.at))
    def test_merge_is_not_rehearsal_without_independent_evidence(self):
        f=self.fixture
        a=f.add('10月1日，去广场玩了',confirmed=True,tags='episode')
        before=f.row(a);self.at+=10*DAY
        f.add('10月2日，去广场玩了',confirmed=True,tags='episode')
        after=f.row(a);self.assertEqual(after['strength_days'],before['strength_days']);self.assertEqual(after['last_access'],before['last_access'])
        m.consolidate_scope('private:10001');self.assertEqual(f.row(a)['strength_days'],before['strength_days'])
    def test_grace_then_soft_archive_protects_core_task_candidate_and_important(self):
        f=self.fixture;ordinary=f.add('ordinary',confirmed=True)
        protected=[f.add('core',confirmed=True,tier='core'),f.add('task',confirmed=True,tier='task'),f.add('candidate'),f.add('important',confirmed=True,importance=.9)]
        with m.db() as c:c.execute('UPDATE memories SET last_access=?',(self.at-1000*DAY,))
        self.assertEqual(m.decay()['removed'],0)
        self.at+=15*DAY
        self.assertEqual(m.decay(False)['removed'],0)
        self.assertEqual(m.decay()['removed'],1)
        self.assertEqual(f.row(ordinary)['status'],'archived')
        self.assertEqual([f.row(i)['status'] for i in protected],['active','active','candidate','active'])

if __name__=='__main__':unittest.main(verbosity=2)
