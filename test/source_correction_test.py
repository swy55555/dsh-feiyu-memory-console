"""Versioned source withdrawal on isolated databases; no paid model or real chat."""
import importlib.util
from pathlib import Path
import unittest
import threading
import json
import http.client
from http.server import ThreadingHTTPServer
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ret',Path(__file__).with_name('source_retention_test.py'))
ret=importlib.util.module_from_spec(spec);spec.loader.exec_module(ret)
m=ret.m;SCOPE=ret.SCOPE

class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.f=ret.SourceRetentionTests();self.f.setUp();self.raw=self.f.original();self.mid=self.f.memory()
    def tearDown(self):self.f.tearDown()
    def prepare(self):return m.prepare_source_correction(SCOPE,self.mid)
    def apply(self,p=None):
        p=p or self.prepare()
        return m.apply_source_correction(SCOPE,self.mid,p['sourceVersion'],p['revision'],'原话说错了；只在周末并不准确')
    def undo(self,r):return m.undo_source_correction(SCOPE,r['sourceVersion'],r['correctionRevision'])

    def test_pause_search_lookup_summary_and_reversible_without_raw_rewrite(self):
        sid=m.add_summary(SCOPE,self.f.at*1000,self.f.at*1000+1,[self.raw['id']],'旧的摘要')['id']
        m.search_memory('咖啡',scope=SCOPE,min_score=0)
        with m.db() as c:raw_before=list(c.execute('SELECT * FROM messages'))
        p=self.prepare();self.assertEqual(p['count'],2)
        with patch.object(m,'embed',side_effect=AssertionError('no model')):r=self.apply(p)
        self.assertEqual(r['paused'],2);self.assertEqual(m.lookup_memories(SCOPE,[self.mid]),[])
        self.assertEqual(m.list_summaries(SCOPE),[])
        self.assertEqual(m.search_memory('咖啡',scope=SCOPE,min_score=0),[])
        with m.db() as c:self.assertEqual(list(c.execute('SELECT * FROM messages')),raw_before)
        self.assertEqual(self.apply()['duplicate'],True)
        result=self.undo(r);self.assertEqual(result['restored'],2)
        self.assertEqual(len(m.lookup_memories(SCOPE,[self.mid])),1)
        self.assertEqual(len(m.list_summaries(SCOPE)),1)

    def test_stale_revision_and_wrong_chat_cannot_mutate(self):
        p=self.prepare()
        with m.db() as c:c.execute("UPDATE memories SET text='后来修改过的记录' WHERE id=?",(self.mid,))
        with self.assertRaisesRegex(ValueError,'变化'):self.apply(p)
        with self.assertRaises(ValueError):m.apply_source_correction('group:2',self.mid,p['sourceVersion'],p['revision'],'错误归属')
        self.assertEqual(self.f.f.row(self.mid)['status'],'active')

    def test_partial_database_failure_rolls_back_entire_withdrawal(self):
        m.add_summary(SCOPE,self.f.at*1000,self.f.at*1000+1,[self.raw['id']],'原摘要')
        with m.db() as c:
            c.execute("CREATE TRIGGER fail_correction BEFORE UPDATE OF status ON session_summaries BEGIN SELECT RAISE(ABORT,'simulated failure'); END")
        with self.assertRaises(m.sqlite3.IntegrityError):self.apply()
        self.assertEqual(self.f.f.row(self.mid)['status'],'active')
        self.assertEqual(len(m.list_summaries(SCOPE)),1)
        with m.db() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM source_corrections').fetchone()[0],0)

    def test_undo_preserves_later_edits_and_checks_revision(self):
        r=self.apply()
        with m.db() as c:c.execute("UPDATE memories SET text='管理员后来修改过正文' WHERE id=?",(self.mid,))
        with self.assertRaises(ValueError):m.undo_source_correction(SCOPE,r['sourceVersion'],0)
        result=self.undo(r);self.assertEqual(result['skipped'],1);self.assertEqual(result['restored'],0)
        row=self.f.f.row(self.mid);self.assertEqual(row['text'],'管理员后来修改过正文');self.assertEqual(row['status'],'archived')

    def test_direct_sql_restore_confirmation_and_late_writes_cannot_bypass(self):
        self.apply()
        for status in ['active','candidate']:
            with self.assertRaisesRegex(m.sqlite3.IntegrityError,'来源已被撤回'):
                with m.db() as c:c.execute('UPDATE memories SET status=? WHERE id=?',(status,self.mid))
        with self.assertRaisesRegex(m.sqlite3.IntegrityError,'来源已被撤回'):
            m.add_summary(SCOPE,self.f.at*1000+5,self.f.at*1000+6,[self.raw['id']],'迟到的摘要')
        # A different chat with the same message number is independent.
        self.f.original(scope='group:2');other=self.f.memory(scope='group:2')
        self.assertEqual(self.f.f.row(other)['status'],'active')

    def test_unavailable_truncated_wrong_author_and_edited_quote_rejected(self):
        with m.db() as c:c.execute("UPDATE memories SET source_text='另一句话' WHERE id=?",(self.mid,))
        with self.assertRaises(ValueError):self.prepare()
        mid=self.f.memory(message='missing')
        with self.assertRaises(ValueError):m.prepare_source_correction(SCOPE,mid)
        raw=m.add_message(SCOPE,'long','人','10001','文'*2000,at=self.f.at*1000,truncated=True)
        mid=m.add_memory('摘要',scope=SCOPE,source_id='long',subject_id='10001',source_text='文'*2000,source_time=self.f.at)['id']
        with self.assertRaises(ValueError):m.prepare_source_correction(SCOPE,mid)

    def test_retained_source_survives_window_eviction_and_ordinary_deletion(self):
        r=self.apply()
        with m.db() as c:
            c.execute('DELETE FROM messages WHERE key=?',(SCOPE,))
            c.execute('DELETE FROM memories WHERE id=?',(self.mid,))
            self.assertIsNotNone(c.execute('SELECT 1 FROM evidence_sources WHERE source_version=?',(r['sourceVersion'],)).fetchone())
        self.assertEqual(self.undo(r)['skipped'],1)

    def test_real_http_requires_local_header_and_preserves_version_checks(self):
        m.API_TOKEN_FILE = str(Path(m.DB_PATH).with_name('api-token'))
        token = m._ensure_api_token()
        server=ThreadingHTTPServer(('127.0.0.1',0),m.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(action,body,headers=None):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                c.request('POST','/sources/correction/'+action,json.dumps(body),headers or {})
                r=c.getresponse();return r.status,json.loads(r.read())
            finally:c.close()
        try:
            b={'scope':SCOPE,'id':self.mid};header={'x-source-correction':'1','content-type':'application/json','x-memvec-token':token}
            self.assertEqual(call('prepare',b)[0],403)
            self.assertEqual(call('prepare',b,{'content-type':'application/json','x-memvec-token':token})[0],403)
            self.assertEqual(call('prepare',b,{**header,'origin':'https://example.invalid'})[0],403)
            status,p=call('prepare',b,header);self.assertEqual(status,200)
            status,r=call('apply',{**b,**p,'reason':'这句原话说错'},header);self.assertEqual(status,200);self.assertEqual(r['paused'],1)
            self.assertEqual(m.source_status(SCOPE,self.mid)['validity'],'revoked')
            self.assertEqual(call('apply',{**b,**p,'reason':'旧预览重复提交'},header)[0],400)
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
