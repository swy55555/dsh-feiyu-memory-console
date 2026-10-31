"""Coverage boundaries for the explicitly optional limited-history mode."""
import importlib.util,os
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('fixtures',Path(__file__).with_name('memvec_test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);m=f.m
class ReviewScopeTests(unittest.TestCase):
    def setUp(self):
        self.fixture=f.MemoryLifecycleTests();self.fixture.setUp()
        self.old=os.environ.pop('MEMVEC_REVIEW_SCOPE',None)
    def tearDown(self):
        os.environ.pop('MEMVEC_REVIEW_SCOPE',None)
        if self.old is not None:os.environ['MEMVEC_REVIEW_SCOPE']=self.old
        self.fixture.tearDown()
    def test_default_is_full_history_and_invalid_setting_fails_closed(self):
        self.assertEqual(m.review_scope(),'all')
        for i in range(12):self.fixture.add('history '+str(i),confirmed=True)
        mid=self.fixture.add('candidate')
        self.assertEqual(m.confirmation_context('private:10001',mid)['total'],12)
        os.environ['MEMVEC_REVIEW_SCOPE']='unknown'
        self.assertEqual(m.review_scope(),'all')
    def test_related_keeps_every_matching_key_and_only_six_fallbacks(self):
        for i in range(10):self.fixture.add('same '+str(i),confirmed=True,fact_key='habit.topic')
        for i in range(12):self.fixture.add('other '+str(i),confirmed=True)
        mid=self.fixture.add('candidate',fact_key='habit.topic')
        os.environ['MEMVEC_REVIEW_SCOPE']='related'
        self.assertEqual(m.confirmation_context('private:10001',mid)['total'],16)
    def test_limited_mode_is_not_complete_conflict_coverage(self):
        for i in range(12):self.fixture.add('history '+str(i),confirmed=True)
        mid=self.fixture.add('candidate')
        full=m.confirmation_context('private:10001',mid)
        Path(m.HOME,'review-scope.txt').write_text('related',encoding='utf-8')
        limited=m.confirmation_context('private:10001',mid)
        self.assertEqual((full['total'],limited['total']),(12,6))
        self.assertNotEqual(full['context']['revision'],limited['context']['revision'])
        os.environ['MEMVEC_REVIEW_SCOPE']='all'
        self.assertEqual(m.confirmation_context('private:10001',mid)['total'],12)
    def test_limited_scope_does_not_accept_missing_source_evidence(self):
        os.environ['MEMVEC_REVIEW_SCOPE']='related'
        mid=self.fixture.add('candidate',source_text='candidate',source_id='source')
        p=m.confirmation_context('private:10001',mid)
        with self.assertRaises(m.MemoryConflict):m.confirm_memory('private:10001',mid,auto_revision=p['context']['revision'])
if __name__=='__main__':unittest.main()
