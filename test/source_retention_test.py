"""Isolated source retention migration and lifecycle tests; no model/network."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('memvec_test.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
m = fixture.m
SCOPE = 'private:10001'


class SourceRetentionTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.MemoryLifecycleTests(); self.f.setUp()
        self.at = m.now()-10000

    def tearDown(self):
        self.f.tearDown()

    def original(self, message='one', text='我只在周末喝咖啡', scope=SCOPE, subject='10001'):
        return m.add_message(scope,message,'用户',subject,text,at=self.at*1000)

    def memory(self, message='one', text='我只在周末喝咖啡', scope=SCOPE, subject='10001'):
        return m.add_memory('用户（QQ '+subject+'）曾说：'+text, tags='habit',scope=scope,
                            source_id=message,subject_id=subject,source_text=text,source_time=self.at,
                            memory_kind='experience')['id']

    def count(self, table):
        with m.db() as c:
            return c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]

    def test_window_eviction_preserves_cited_original_but_does_not_expand_context(self):
        self.original(); mid=self.memory()
        with m.db() as c:
            c.executemany('INSERT INTO messages(id,key,message_id,sender,user_id,text,at,is_self,meta) VALUES(?,?,?,?,?,?,?,?,?)',
                          [('filler:'+str(i),SCOPE,'fill-'+str(i),'用户','10001','无关闲聊',(self.at+i+1)*1000,0,'') for i in range(5000)])
        m.add_message(SCOPE,'last','用户','10001','最后一条',at=m.now()*1000)
        self.assertEqual(self.count('messages'),5000)
        status=m.source_status(SCOPE,mid)
        self.assertEqual(status['status'],'matched');self.assertTrue(status['retained']);self.assertFalse(status['inRecentWindow'])
        self.assertNotIn('我只在周末喝咖啡',str(m.context_messages(SCOPE)))
        before=self.f.row(mid)
        with m.db() as c:
            self.assertIsNotNone(m._experience_source(c,before))
        duplicate=self.original(text='我每天喝咖啡')
        self.assertTrue(duplicate['sourceConflict'])
        self.assertEqual(m.source_status(SCOPE,mid)['version'],status['version'])
        self.assertEqual(before,self.f.row(mid))

    def test_versions_are_scoped_exact_and_duplicate_delivery_is_not_correction(self):
        first=self.original()
        again=m.add_message(SCOPE,'one','改名','10001','我只在周末喝咖啡',at=m.now()*1000)
        self.assertEqual(first['sourceVersion'],again['sourceVersion']);self.assertFalse(again['sourceConflict'])
        other=self.original(scope='group:2')
        self.assertNotEqual(first['sourceVersion'],other['sourceVersion'])
        changed=self.original(text='我不只在周末喝咖啡')
        self.assertTrue(changed['sourceConflict'])
        mid=self.memory()
        with self.assertRaises(ValueError):m.source_status('group:2',mid)

    def test_missing_or_mismatched_original_is_never_reconstructed_from_candidate(self):
        mid=self.memory()
        self.assertEqual(m.source_status(SCOPE,mid)['status'],'unavailable')
        self.assertEqual(self.count('evidence_sources'),0)
        self.original(text='别人说我只在周末喝咖啡，但那不是真的')
        self.assertEqual(m.source_status(SCOPE,mid)['status'],'mismatch')
        self.assertEqual(self.count('evidence_sources'),0)

    def test_late_raw_delivery_pins_candidate_and_deleting_one_reference_preserves_others(self):
        mid=self.memory();raw=self.original()
        self.assertEqual(m.source_status(SCOPE,mid)['status'],'matched')
        summary=m.add_summary(SCOPE,self.at*1000,self.at*1000+1,[raw['id']],'当天聊天')['id']
        with m.db() as c:c.execute('DELETE FROM messages WHERE key=?',(SCOPE,))
        m.remove_memory(SCOPE,mid)
        self.assertEqual(self.count('evidence_sources'),1)
        m.delete_summary(SCOPE,summary)
        # Both are soft deletes. Preserve evidence for undo; only physical removal releases it.
        self.assertEqual(self.count('evidence_sources'),1)
        with m.db() as c:
            c.execute("UPDATE memories SET status='active' WHERE id=?",(mid,))
        self.assertEqual(m.source_status(SCOPE,mid)['status'],'matched')
        with m.db() as c:
            c.execute('DELETE FROM memories WHERE id=?',(mid,))
            self.assertEqual(c.execute('SELECT COUNT(*) FROM evidence_sources').fetchone()[0],1)
            c.execute('DELETE FROM session_summaries WHERE id=?',(summary,))
        self.assertEqual(self.count('evidence_sources'),0)
        self.assertEqual(self.count('evidence_links'),0)

    def test_source_change_keeps_history_for_undo_without_marking_old_version_current(self):
        self.original();mid=self.memory()
        with m.db() as c:
            c.execute('DELETE FROM messages WHERE key=?',(SCOPE,))
            c.execute("UPDATE memories SET source_text='人工编辑后的片段' WHERE id=?",(mid,))
            self.assertEqual(c.execute('SELECT current FROM evidence_links').fetchone()[0],0)
        self.assertEqual(self.count('evidence_sources'),1)
        with m.db() as c:c.execute("UPDATE memories SET source_text='我只在周末喝咖啡' WHERE id=?",(mid,))
        self.assertEqual(m.source_status(SCOPE,mid)['status'],'matched')

    def test_bridge_registration_checks_scope_speaker_quote_and_validates_whole_batch(self):
        self.original()
        ref={'namespace':'event','id':m._source_event_id(SCOPE,'one'),'subject':'10001','quote':'周末喝咖啡'}
        owner={'kind':'belief','id':'b1','refs':[ref]}
        with self.assertRaises(ValueError):m.retain_source_refs(SCOPE,[owner,{'kind':'invalid'}])
        self.assertEqual(self.count('evidence_sources'),0)
        self.assertEqual(m.retain_source_refs('group:2',[owner])['unavailable'],1)
        self.assertEqual(m.retain_source_refs(SCOPE,[{**owner,'refs':[{**ref,'subject':'222'}]}])['unavailable'],1)
        self.assertEqual(m.retain_source_refs(SCOPE,[{**owner,'refs':[{**ref,'quote':'凭空编造'}]}])['mismatch'],1)
        for _ in range(2):self.assertEqual(m.retain_source_refs(SCOPE,[owner])['matched'],1)
        self.assertEqual(self.count('evidence_sources'),1);self.assertEqual(self.count('evidence_links'),1)

    def test_backfill_uses_only_surviving_raw_and_is_idempotent(self):
        self.original();mid=self.memory();missing=self.memory(message='missing')
        before=self.f.row(mid)
        with m.db() as c:
            # Reconstruct an actual pre-source-schema database, including removing later guards.
            for row in c.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'evidence_%' OR name LIKE 'correction_guard_%')").fetchall():
                c.execute('DROP TRIGGER '+row[0])
            c.execute('DROP VIEW evidence_source_lookup')
            for table in ('evidence_links','evidence_sources','source_schema','source_corrections','source_correction_history'):c.execute('DROP TABLE '+table)
            c.execute('DROP INDEX idx_messages_event')
            c.execute('ALTER TABLE messages DROP COLUMN source_version');c.execute('ALTER TABLE messages DROP COLUMN event_id')
        for _ in range(2):
            self.assertEqual(m.source_status(SCOPE,mid)['status'],'matched')
            self.assertEqual(m.source_status(SCOPE,missing)['status'],'unavailable')
            self.assertEqual(self.count('evidence_sources'),1)
        self.assertEqual(before,self.f.row(mid))

    def test_explicit_or_legacy_truncation_never_claims_full_source_validation(self):
        for index,truncated,text in [(1,True,'只是前半句话'),(2,None,'字'*2000)]:
            m.add_message(SCOPE,str(index),'用户','10001',text,at=self.at*1000,truncated=truncated)
            mid=self.f.add('来源片段',source_id=str(index),source_text=text,source_time=self.at)
            self.assertEqual(m.source_status(SCOPE,mid)['status'],'partial')
        self.assertEqual(self.count('evidence_sources'),0)


if __name__=='__main__':unittest.main()
