"""Sources, transactions and privacy using isolated databases and fake vectors."""
import importlib.util
from pathlib import Path
import unittest
import sqlite3
from contextlib import closing
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('ret',Path(__file__).with_name('source_retention_test.py'))
ret=importlib.util.module_from_spec(spec);spec.loader.exec_module(ret)
m=ret.m;SCOPE=ret.SCOPE

class EvidenceTests(unittest.TestCase):
    def setUp(self):self.f=ret.SourceRetentionTests();self.f.setUp()
    def tearDown(self):self.f.tearDown()
    def search(self,q,**extra):return m.search_evidence({'scope':SCOPE,'query':q,**extra})
    def test_raw_words_available_before_extraction_and_subject_is_preserved(self):
        raw=self.f.original(text='我喜欢烤肉和火锅')
        rows=self.search('烤肉')['results'];self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['contract']['sourceVersion'],raw['sourceVersion'])
        self.assertEqual(rows[0]['memory_kind'],'utterance');self.assertEqual(rows[0]['contract']['speaker'],'10001')
        self.assertEqual(self.search('烤肉',subject='another')['results'],[])
    def test_query_syntax_is_literal_and_scope_cannot_escape(self):
        self.f.original(text='I enjoy hiking and photography')
        self.f.original('private',text='private secret photography',scope='private:20002',subject='20002')
        for q in ['photography', 'photography" OR *', "' OR 1=1 --",'NEAR(*)']:
            self.assertTrue(all(r['scope']==SCOPE and 'private secret' not in r['text'] for r in self.search(q)['results']))
    def test_root_dedup_prefers_full_original_over_partial_derived_fact(self):
        text='我只在周末喝咖啡，工作日喝茶，晚上不喝咖啡'
        raw=self.f.original(text=text);mid=self.f.memory(text=text)
        with m.db() as c:
            result=m.evidence_store.search(c,SCOPE,'preference',vectors=[{'id':mid,'scope':SCOPE,'text':'咖啡偏好','score':.99}])
        self.assertEqual(result['results'][0]['text'],text)
        self.assertEqual(result['results'][0]['associationId'],mid)
        self.assertEqual(len(result['results']),1)
    def test_withdrawal_invalidates_index_and_expansion_then_undo_restores(self):
        raw=self.f.original();mid=self.f.memory();m.index_evidence()
        p=m.prepare_source_correction(SCOPE,mid)
        r=m.apply_source_correction(SCOPE,mid,p['sourceVersion'],p['revision'],'whole original was incorrect')
        self.assertEqual(self.search('咖啡')['results'],[])
        with m.db() as c:self.assertEqual(m.evidence_store.expand(c,SCOPE,[raw['sourceVersion']]),[])
        m.undo_source_correction(SCOPE,r['sourceVersion'],r['correctionRevision'])
        self.assertTrue(self.search('咖啡')['results'])
    def test_delete_removes_body_and_vector_from_rebuildable_index(self):
        raw=self.f.original();m.index_evidence()
        with m.db() as c:c.execute('DELETE FROM messages WHERE id=?',(raw['id'],))
        with m.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM evidence_fts').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT count(*) FROM evidence_vectors').fetchone()[0],0)
            self.assertNotIn('咖啡',str(m.evidence_store.changes(c)))
    def test_pinned_original_survives_window_eviction_but_not_final_release(self):
        raw=self.f.original();mid=self.f.memory()
        with m.db() as c:c.execute('DELETE FROM messages WHERE id=?',(raw['id'],))
        self.assertTrue(self.search('咖啡')['results'])
        with m.db() as c:c.execute('DELETE FROM memories WHERE id=?',(mid,))
        self.assertFalse(self.search('咖啡')['results'])
    def test_outbox_is_commit_atomic_and_rebuild_is_repeatable(self):
        raw=self.f.original()
        with m.db() as c:before=m.evidence_store.revision(c)
        c=m.db();c.commit();c.execute('BEGIN IMMEDIATE');c.execute('DELETE FROM messages WHERE id=?',(raw['id'],))
        with closing(sqlite3.connect(m.DB_PATH)) as reader:self.assertEqual(m.evidence_store.revision(reader),before)
        c.rollback();c.close()
        for _ in range(2):
            with m.db() as c:m.evidence_store.install(c,rebuild=True)
        with m.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM evidence_fts').fetchone()[0],1)
            self.assertEqual(m.evidence_store.revision(c),before)
    def test_rebuild_interruption_rolls_back_and_retry_succeeds(self):
        self.f.original();c=m.db();c.commit();c.execute('BEGIN IMMEDIATE')
        try:
            m.evidence_store.install(c,rebuild=True)
            raise RuntimeError('injected before commit')
        except RuntimeError:c.rollback()
        finally:c.close()
        self.assertTrue(self.search('咖啡')['results'])
    def test_vector_model_and_dimensions_are_explicit_and_no_query_reinforcement(self):
        raw=self.f.original();mid=self.f.memory();before=self.f.f.row(mid)
        self.assertEqual(m.index_evidence()['indexed'],1)
        self.assertEqual(m.index_evidence()['indexed'],0)
        result=self.search('something semantically related')
        self.assertTrue(result['results']);self.assertEqual(self.f.f.row(mid),before)
        with m.db() as c:
            c.execute('UPDATE evidence_vectors SET dimensions=99')
            # Isolate raw-vector retrieval: a valid derived memory may legitimately
            # expand to its original even if the independent raw vector is corrupt.
            c.execute("UPDATE memories SET status='candidate' WHERE id=?",(mid,))
        self.assertFalse(any(r['id']=='source:'+raw['sourceVersion'] for r in self.search('unrelated')['results']))
        with patch.object(m,'MODEL','different-model'):
            result=self.search('咖啡');self.assertEqual(result['vectorStatus'],'unavailable');self.assertTrue(result['results'])
    def test_vector_failure_does_not_hide_original_or_confirm_candidate(self):
        self.f.original();self.f.memory()
        with patch.object(m,'embed',side_effect=RuntimeError('offline')):
            r=self.search('咖啡');self.assertEqual(r['vectorStatus'],'unavailable');self.assertTrue(r['results'])
    def test_time_types_and_scope_bound_neighbours(self):
        raw=self.f.original(text='The event was cancelled; it was my friend.')
        self.f.original('foreign',scope='private:30003',subject='30003',text='foreign conversation')
        with m.db() as c:
            rows=m.evidence_store.expand(c,SCOPE,[raw['sourceVersion']],5)
        self.assertTrue(rows);self.assertTrue(all(r['scope']==SCOPE for r in rows))
        self.assertIsNone(rows[0]['contract']['eventAt']);self.assertIsNone(rows[0]['contract']['plannedAt'])
        with self.assertRaises(ValueError):self.search('event',time={'basis':'event','from':1,'to':2})
        self.assertEqual(self.search('event',time={'basis':'spoken','from':1,'to':2})['results'],[])
        self.assertEqual(m.evidence_store.temporal_query('2026-02-30')['basis'],'unknown')

if __name__=='__main__':unittest.main()
