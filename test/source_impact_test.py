"""Dependency previews must neither mutate memory nor infer unrecorded dependencies."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('retention',Path(__file__).with_name('source_retention_test.py'))
ret=importlib.util.module_from_spec(spec);spec.loader.exec_module(ret)
m=ret.m;SCOPE=ret.SCOPE

class SourceImpactTests(unittest.TestCase):
    def setUp(self):
        self.f=ret.SourceRetentionTests();self.f.setUp()
        self.raw=self.f.original();self.mid=self.f.memory()
    def tearDown(self):self.f.tearDown()

    def test_direct_links_snapshot_is_read_only_and_local(self):
        sid=m.add_summary(SCOPE,self.f.at*1000,self.f.at*1000+1,[self.raw['id']],'周末偏好')['id']
        m.retain_source_refs(SCOPE,[{'kind':'belief','id':'b1','refs':[{'namespace':'message','id':'one','subject':'10001','quote':'周末'}]}])
        with m.db() as c:before=list(c.iterdump())
        with patch.object(m,'embed',side_effect=AssertionError('no model')):
            result=m.source_impact(SCOPE,self.mid)
        self.assertEqual(result['status'],'matched');self.assertEqual(result['modelCalls'],0)
        self.assertEqual({(x['kind'],x['id']) for x in result['items']},{('memory',self.mid),('summary',sid),('bridge:belief','b1')})
        self.assertEqual(result['coverage'],'recorded-direct-only')
        with m.db() as c:self.assertEqual(list(c.iterdump()),before)

    def test_cross_chat_and_author_do_not_leak(self):
        self.f.original(scope='group:2');other=self.f.memory(scope='group:2')
        with self.assertRaises(ValueError):m.source_impact('group:2',self.mid)
        ids={x['id'] for x in m.source_impact(SCOPE,self.mid)['items']};self.assertNotIn(other,ids)
        with m.db() as c:c.execute("UPDATE memories SET subject_id='999' WHERE id=?",(self.mid,))
        self.assertEqual(m.source_impact(SCOPE,self.mid)['status'],'unavailable')

    def test_historical_reference_is_not_current_and_archive_is_queryable(self):
        sid=m.add_summary(SCOPE,self.f.at*1000,self.f.at*1000+1,[self.raw['id']],'旧摘要')['id']
        with m.db() as c:
            c.execute("UPDATE session_summaries SET covered_ids='[]' WHERE id=?",(sid,))
            c.execute('DELETE FROM messages WHERE key=?',(SCOPE,))
        result=m.source_impact(SCOPE,self.mid)
        self.assertEqual(result['status'],'matched')
        self.assertEqual(next(x for x in result['items'] if x['id']==sid)['reference'],'historical')

    def test_missing_mismatched_and_truncated_sources_are_honest(self):
        missing=self.f.memory(message='absent')
        self.assertEqual(m.source_impact(SCOPE,missing)['status'],'unavailable')
        with m.db() as c:c.execute("UPDATE memories SET source_text='另一个说法' WHERE id=?",(self.mid,))
        self.assertEqual(m.source_impact(SCOPE,self.mid)['status'],'mismatch')
        text='文'*2000
        m.add_message(SCOPE,'long','用户','10001',text,at=self.f.at*1000,truncated=True)
        mid=m.add_memory('长原话的摘要',scope=SCOPE,source_id='long',subject_id='10001',source_text=text,source_time=self.f.at)['id']
        self.assertEqual(m.source_impact(SCOPE,mid)['status'],'partial')

    def test_hash_tampering_and_unrecorded_similarity_not_dependencies(self):
        self.f.original(message='second',text='我喜欢周末喝咖啡')
        other=self.f.memory(message='second',text='我喜欢周末喝咖啡')
        self.assertNotIn(other,{x['id'] for x in m.source_impact(SCOPE,self.mid)['items']})
        with m.db() as c:c.execute("UPDATE messages SET source_version=? WHERE id=?",('a'*64,self.raw['id']))
        self.assertEqual(m.source_impact(SCOPE,self.mid)['status'],'unavailable')

    def test_opt_in_provenance_changes_on_source_or_content_not_access(self):
        self.assertNotIn('provenance',m.lookup_memories(SCOPE,[self.mid])[0])
        p=m.lookup_memories(SCOPE,[self.mid],True)[0]['provenance']
        self.assertEqual(p['sourceVersion'],m.source_impact(SCOPE,self.mid)['source']['version'])
        with m.db() as c:c.execute('UPDATE memories SET access_count=access_count+1 WHERE id=?',(self.mid,))
        self.assertEqual(m.lookup_memories(SCOPE,[self.mid],True)[0]['provenance'],p)
        with m.db() as c:c.execute("UPDATE memories SET text='改后的记忆' WHERE id=?",(self.mid,))
        changed=m.lookup_memories(SCOPE,[self.mid],True)[0]['provenance']
        self.assertNotEqual(changed['memoryVersion'],p['memoryVersion'])
        self.assertEqual(changed['sourceVersion'],p['sourceVersion'])
        with m.db() as c:c.execute("UPDATE memories SET source_text='未经核对的新来源' WHERE id=?",(self.mid,))
        self.assertIsNone(m.lookup_memories(SCOPE,[self.mid],True)[0]['provenance']['sourceVersion'])

if __name__=='__main__':unittest.main()
