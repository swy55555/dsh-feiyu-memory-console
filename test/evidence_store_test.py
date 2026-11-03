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
    def qa(self, intervening=False):
        q=m.add_message(SCOPE,'q','Questioner','10001','What food do you like?',at=self.f.at*1000)
        if intervening:
            m.add_message(SCOPE,'middle','Other','10003','Unrelated interruption',at=(self.f.at+1)*1000)
        a=m.add_message(SCOPE,'a','Answerer','10002','Meat, hotpot and barbecue.',at=(self.f.at+2)*1000)
        return q,a
    def test_context_group_preserves_pair_without_changing_evidence_text(self):
        q,a=self.qa()
        with m.db() as c:
            rows=[m.evidence_store.contract(m.evidence_store.source(c,SCOPE,r['sourceVersion'])) for r in (q,a)]
            groups=m.evidence_store.context_groups(c,SCOPE,rows)
            self.assertEqual(groups[0]['retrieval']['contextVersions'],[q['sourceVersion'],a['sourceVersion']])
            self.assertEqual(m.evidence_store.limit_context_groups(groups,1),[])
            self.assertEqual(len(m.evidence_store.limit_context_groups(groups,2)),2)
            self.assertEqual(groups[1]['text'],'Meat, hotpot and barbecue.')
    def test_unindexed_short_answer_is_completed_on_first_retrieval(self):
        q=m.add_message(SCOPE,'q','小李','10001','你最喜欢吃什么？',at=self.f.at*1000)
        a=m.add_message(SCOPE,'a','小王','10002','肉、烤肉、火锅和烧烤。',at=(self.f.at+2)*1000)
        result=self.search('喜欢吃什么')['results']
        self.assertEqual({r['contract']['messageId'] for r in result},{'q','a'})
        self.assertTrue(all(len(r['retrieval']['contextVersions'])==2 for r in result))
        self.assertEqual(self.search('喜欢吃什么',limit=1)['results'],[])
        self.assertEqual([r['contract']['messageId'] for r in self.search('喜欢吃什么',subject='10001')['results']],['q'])
        self.assertEqual([r['contract']['messageId'] for r in self.search('喜欢吃什么',time={'basis':'spoken','from':self.f.at*1000,'to':(self.f.at+1)*1000})['results']],['q'])
    def test_unindexed_completion_does_not_skip_invalid_or_foreign_neighbours(self):
        self.qa(intervening=True)
        m.add_message('private:20002','foreign','Other','20002','private answer',at=(self.f.at+1)*1000)
        result=self.search('What food do you like?')['results']
        self.assertFalse(any(r['contract']['messageId']=='a' for r in result))
        self.assertTrue(all(r['scope']==SCOPE for r in result))
    def test_unindexed_completion_rechecks_revocation_and_truncation(self):
        self.qa()
        with m.db() as c:
            c.execute("UPDATE messages SET source_truncated=1 WHERE message_id='a'")
        self.assertFalse(any(r['contract']['messageId']=='a' for r in self.search('food')['results']))
        with m.db() as c:
            c.execute("UPDATE messages SET source_truncated=0 WHERE message_id='a'")
        mid=m.add_memory('Meat, hotpot and barbecue.',scope=SCOPE,source_id='a',subject_id='10002',
                         source_text='Meat, hotpot and barbecue.',source_time=self.f.at+2,memory_kind='experience')['id']
        p=m.prepare_source_correction(SCOPE,mid)
        m.apply_source_correction(SCOPE,mid,p['sourceVersion'],p['revision'],'wrong answer')
        self.assertFalse(any(r['contract']['messageId']=='a' for r in self.search('food')['results']))
    def test_unindexed_completion_leaves_indexed_candidates_unchanged(self):
        q,a=self.qa()
        m.index_evidence()
        with m.db() as c:
            rows=[m.evidence_store.contract(m.evidence_store.source(c,SCOPE,q['sourceVersion']))]
            self.assertEqual(m.evidence_store.complete_unindexed_answers(c,SCOPE,rows,m.MODEL),rows)
    def test_unindexed_completion_respects_same_speaker_time_and_question_boundaries(self):
        m.add_message(SCOPE,'q','小李','10001','你喜欢什么？',at=self.f.at*1000)
        for speaker,delay,text in [('10001',2,'肉。'),('10002',121,'肉。'),('10002',2,'你呢？'),('10002',2,'肉'*601)]:
            with self.subTest(speaker=speaker,delay=delay):
                with m.db() as c:c.execute("DELETE FROM messages WHERE message_id='a'")
                m.add_message(SCOPE,'a','说话人',speaker,text,at=(self.f.at+delay)*1000)
                self.assertFalse(any(r['contract']['messageId']=='a' for r in self.search('喜欢什么')['results']))
    def test_group_completes_already_held_question_in_one_remaining_slot(self):
        q,a=self.qa()
        with m.db() as c:
            rows=[m.evidence_store.contract(m.evidence_store.source(c,SCOPE,a['sourceVersion']))]
            groups=m.evidence_store.context_groups(c,SCOPE,rows,[q['sourceVersion']])
            self.assertEqual(len(groups[0]['retrieval']['contextVersions']),2)
            self.assertEqual(len(m.evidence_store.limit_context_groups(groups,1,[q['sourceVersion']])),1)
    def test_group_never_jumps_over_an_unselected_intervening_source(self):
        q,a=self.qa(True)
        with m.db() as c:
            rows=[m.evidence_store.contract(m.evidence_store.source(c,SCOPE,r['sourceVersion'])) for r in (q,a)]
            groups=m.evidence_store.context_groups(c,SCOPE,rows)
            self.assertFalse(any(r.get('retrieval',{}).get('contextVersions') for r in groups))
    def test_followup_group_does_not_relax_subject_or_typed_time_filter(self):
        q,a=self.qa()
        result=self.search('food',anchors=[q['sourceVersion']],subject='10001')
        self.assertTrue(all(r['contract']['speaker']=='10001' for r in result['results']))
        result=self.search('food',anchors=[q['sourceVersion']],time={'basis':'spoken','from':self.f.at*1000,'to':(self.f.at+1)*1000})
        self.assertTrue(all(r['contract']['messageId']=='q' for r in result['results']))
    def test_revoked_companion_is_never_added_by_group_detection(self):
        q,a=self.qa()
        with m.db() as c:
            c.execute('DELETE FROM messages WHERE message_id=?',('a',))
            row=m.evidence_store.contract(m.evidence_store.source(c,SCOPE,q['sourceVersion']))
            groups=m.evidence_store.context_groups(c,SCOPE,[row],[a['sourceVersion']])
            self.assertNotIn('contextVersions',groups[0].get('retrieval',{}))
    def test_whole_word_ranking_keeps_picnic_above_generic_pic(self):
        for i in range(6):self.f.original(str(i),text='What a great pic! Thanks for sharing it with me.')
        right=self.f.original('right',text='We had a picnic last week, even though it rained.')
        result=self.search('When did I have a picnic?')
        self.assertEqual(result['results'][0]['contract']['sourceVersion'],right['sourceVersion'])
        self.assertNotIn('art',m.evidence_store._lex.tokens('The party started yesterday'))
    def test_speaker_hint_uses_actual_speaker_not_only_addressed_name(self):
        m.add_message(SCOPE,'own','Mira','10001','I received a scholarship for robotics.',at=self.f.at*1000)
        m.add_message(SCOPE,'other','Jon','10001','Mira, I received a scholarship for music.',at=(self.f.at+1)*1000)
        result=self.search('What scholarship did Mira receive?')
        self.assertEqual(result['results'][0]['contract']['messageId'],'own')
    def test_anchor_followup_excludes_delivered_sources_before_result_limit(self):
        anchor=self.f.original('anchor',text='We attended a concert yesterday.')
        self.f.original('answer',text='The performer was a local violinist.')
        result=self.search('concert',anchors=[anchor['sourceVersion']],exclude=[anchor['sourceVersion']],limit=1)
        self.assertEqual(len(result['results']),1)
        self.assertEqual(result['results'][0]['contract']['messageId'],'answer')
        with self.assertRaises(ValueError):self.search('concert',exclude=['not-a-source-version'])
    def test_lexical_cache_changes_with_sources_and_chinese_speakers(self):
        m.add_message(SCOPE,'one','小李','10001','我喜欢游泳，但是不喜欢跑步。',at=self.f.at*1000)
        m.add_message(SCOPE,'two','小王','10001','小李，我喜欢跑步。',at=(self.f.at+1)*1000)
        self.assertEqual(self.search('小李喜欢什么运动')['results'][0]['contract']['messageId'],'one')
        with m.db() as c:c.execute("DELETE FROM messages WHERE message_id='one'")
        self.assertFalse(any(r['contract'].get('messageId')=='one' for r in self.search('小李喜欢什么运动')['results']))
    def test_shared_query_embedding_is_computed_once(self):
        self.f.original()
        original=m.embed
        with patch.object(m,'embed',wraps=original) as embedded:
            self.search('喜欢咖啡')
            self.assertEqual(embedded.call_count,1)
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
