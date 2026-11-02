"""Exercise real retrieval with maximally similar vectors, isolated storage only.

These tests isolate de-duplication correctness, not embedding model accuracy.
"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('memvec_test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
m = fixture.m
SCOPE = 'private:10001'


class RetrievalDistinctions(unittest.TestCase):
    def setUp(self):
        self.f = fixture.MemoryLifecycleTests()
        self.f.setUp()

    def tearDown(self):
        self.f.tearDown()

    def pair(self, left, right, **second):
        a = self.f.add(left, confirmed=True, source_id='source-a', source_time=1700000000)
        b = self.f.add(right, confirmed=True, source_id='source-b', source_time=1700086400, **second)
        found = {r['id'] for r in m.search_memory('相关经历', scope=SCOPE, k=20, min_score=0)}
        self.assertTrue({a, b}.issubset(found), (left, right, found))

    def test_negation(self):
        self.pair('我喜欢喝咖啡。', '我不喜欢喝咖啡。')

    def test_dates(self):
        # Isolate retrieval from the write-time recurring-event merger.
        a = self.f.add('2026年11月1日去过公园', confirmed=True, source_id='a', source_time=1700000000)
        b = self.clone(a, text='2026年11月2日去过公园', source_id='b', source_time=1700086400)
        ids = {r['id'] for r in m.search_memory('公园', scope=SCOPE, k=20, min_score=0)}
        self.assertEqual(ids, {a, b})

    def test_conditions(self):
        self.pair('周末有空时去公园。', '周末下雨时不去公园。')

    def test_person(self):
        self.pair('我喜欢喝茶。', '我喜欢喝茶。', subject='10002')

    def test_distinct_entities(self):
        self.pair('我喜欢乌龙茶。', '我喜欢红茶。')

    def test_quoted_and_asserted_text(self):
        self.pair('朋友说“我喜欢咖啡”。', '我喜欢咖啡。')

    def test_punctuation_is_not_evidence_of_equivalence(self):
        self.pair('不，我喜欢茶。', '不喜欢茶。')

    def test_relative_dates_preserve_different_source_times(self):
        a = self.f.add('我明天出发。', confirmed=True, source_id='a', source_time=1700000000)
        # Simulate historical identical rows; ordinary writes already de-duplicate exact facts.
        b = self.clone(a, source_id='b', source_time=1700086400)
        ids = {r['id'] for r in m.search_memory('出发', scope=SCOPE, k=20, min_score=0)}
        self.assertEqual(ids, {a, b})

    def clone(self, mid, **changes):
        row = self.f.row(mid)
        row.update(id=mid+'-copy', **changes)
        with m.db() as c:
            c.execute('INSERT INTO memories ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')', tuple(row.values()))
        return row['id']

    def test_exact_same_provenance_duplicate_is_collapsed_without_writes(self):
        a = self.f.add('我喜欢茶。', confirmed=True, source_id='a', source_text='我喜欢茶。', source_time=1700000000)
        self.clone(a)
        before = self.f.row(a)
        result = m.search_memory('茶', scope=SCOPE, k=20, min_score=0)
        self.assertEqual(len(result), 1)
        self.assertEqual(self.f.row(a), before)

    def test_unknown_provenance_does_not_establish_duplicate_evidence(self):
        a = self.f.add('我明天出发。', confirmed=True)
        b = self.clone(a)
        ids = {r['id'] for r in m.search_memory('出发', scope=SCOPE, k=20, min_score=0)}
        self.assertEqual(ids, {a, b})

    def test_scope_status_and_limit_remain_enforced(self):
        self.f.add('别人的资料', scope='private:20002', confirmed=True)
        self.f.add('待核对资料')
        for i in range(4):
            self.f.add('当前会话资料'+str(i), confirmed=True, source_id=str(i))
        rows = m.search_memory('资料', scope=SCOPE, k=2, min_score=0)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r['scope'] == SCOPE and r['text'].startswith('当前会话') for r in rows))


if __name__ == '__main__':
    unittest.main()
