"""No external models: exact source/version guards for the reused semantic judgement."""
import importlib.util,json,unittest,threading,http.client
from pathlib import Path
from http.server import ThreadingHTTPServer
spec=importlib.util.spec_from_file_location('ret',Path(__file__).with_name('source_retention_test.py'))
ret=importlib.util.module_from_spec(spec);spec.loader.exec_module(ret);m=ret.m;S=ret.SCOPE

class ChatClarificationTests(unittest.TestCase):
    def setUp(self):
        self.f=ret.SourceRetentionTests();self.f.setUp();self.f.at=m.now()-60
        self.raw=self.f.original(text='我明天要去杭州');self.mid=self.f.memory(text='我明天要去杭州')
        self.current=m.add_message(S,'new','用户','10001','刚才那句我明天去杭州说错了，整句都不算。',at=m.now()*1000-1000)
        self.body={'scope':S,'currentId':'new','currentVersion':self.current['sourceVersion'],'targetId':'one','targetVersion':self.raw['sourceVersion'],'targetRevision':0,
            'proposal':{'kind':'whole_retraction','targetId':'one','oldQuote':'我明天要去杭州','quote':'刚才那句我明天去杭州说错了，整句都不算。','speaker':'self','mode':'asserted','coverage':'entire','explicit':True,'confidence':.99}}
    def tearDown(self):self.f.tearDown()
    def test_applies_once_keeps_both_sources_and_does_not_reapply_after_undo(self):
        r=m.apply_chat_clarification(self.body);self.assertEqual(r['status'],'applied');self.assertEqual(r['paused'],1)
        self.assertEqual(self.f.f.row(self.mid)['status'],'archived')
        self.assertEqual(m.apply_chat_clarification(self.body)['status'],'already-processed')
        m.undo_source_correction(S,self.raw['sourceVersion'],r['correctionRevision'])
        self.assertEqual(m.apply_chat_clarification(self.body)['status'],'already-processed');self.assertEqual(self.f.f.row(self.mid)['status'],'active')
        with m.db() as c:
            c.execute('DELETE FROM messages')
            self.assertIsNotNone(c.execute('SELECT 1 FROM evidence_sources WHERE source_version=?',(self.current['sourceVersion'],)).fetchone())
            self.assertEqual(c.execute('SELECT COUNT(*) FROM source_clarifications').fetchone()[0],1)
    def test_partial_temporal_uncertain_quoted_joke_and_incomplete_evidence_cannot_withdraw(self):
        variants=[{'kind':'partial_correction'},{'kind':'time_change'},{'kind':'uncertain'},{'mode':'quoted'},{'mode':'joke'},{'mode':'hypothetical'},{'coverage':'partial'},{'speaker':'other'},{'explicit':False},{'confidence':.9},{'confidence':True},{'quote':'整句都不算'},{'oldQuote':'去杭州'}]
        for change in variants:
            with self.subTest(change=change),self.assertRaises(ValueError):m.apply_chat_clarification({**self.body,'proposal':{**self.body['proposal'],**change}})
        self.assertEqual(self.f.f.row(self.mid)['status'],'active')
    def test_stale_versions_cross_chat_wrong_target_and_newer_input_rejected(self):
        for change in [{'scope':'group:2'},{'currentVersion':'a'*64},{'targetVersion':'b'*64},{'targetRevision':1},{'targetId':'new'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):m.apply_chat_clarification({**self.body,**change})
        m.add_message(S,'later','用户','10001','先别改',at=m.now()*1000)
        with self.assertRaisesRegex(ValueError,'更新'):m.apply_chat_clarification(self.body)
    def test_other_author_or_self_generated_source_is_not_accepted(self):
        for is_self,subject in [(True,'10001'),(False,'999')]:
            old=m.add_message(S,'wrong'+str(is_self),'人',subject,'我明天要去杭州',at=self.f.at*1000,is_self=is_self)
            body={**self.body,'targetId':'wrong'+str(is_self),'targetVersion':old['sourceVersion'],'proposal':{**self.body['proposal'],'targetId':'wrong'+str(is_self)}}
            with self.assertRaises(ValueError):m.apply_chat_clarification(body)
    def test_late_derived_write_is_blocked_even_without_memory_when_clarified(self):
        with m.db() as c:c.execute('DELETE FROM memories WHERE id=?',(self.mid,))
        r=m.apply_chat_clarification(self.body);self.assertEqual(r['paused'],0)
        with self.assertRaises(m.sqlite3.IntegrityError):self.f.memory(text='我明天要去杭州')
    def test_receipt_failure_rolls_back_pause_and_evidence_changes(self):
        with m.db() as c:c.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON source_clarifications BEGIN SELECT RAISE(ABORT,'failed receipt'); END")
        with self.assertRaises(m.sqlite3.IntegrityError):m.apply_chat_clarification(self.body)
        self.assertEqual(self.f.f.row(self.mid)['status'],'active')
        with m.db() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM source_corrections').fetchone()[0],0)
    def test_actual_http_route_enforces_header_and_returns_idempotent_result(self):
        m.API_TOKEN_FILE = str(Path(m.DB_PATH).with_name('api-token'))
        token = m._ensure_api_token()
        server=ThreadingHTTPServer(('127.0.0.1',0),m.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(headers):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                c.request('POST','/sources/clarification/apply',json.dumps(self.body),headers);r=c.getresponse();return r.status,json.loads(r.read())
            finally:c.close()
        try:
            self.assertEqual(call({'content-type':'application/json','x-memvec-token':token})[0],403)
            self.assertEqual(call({})[0],403);self.assertEqual(call({'x-source-correction':'1','origin':'https://example.invalid'})[0],403)
            self.assertEqual(call({'x-source-correction':'1','content-type':'application/json','x-memvec-token':token})[1]['status'],'applied')
            self.assertEqual(call({'x-source-correction':'1','content-type':'application/json','x-memvec-token':token})[1]['status'],'already-processed')
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
