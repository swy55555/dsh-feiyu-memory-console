import importlib.util
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).resolve().parents[1] / 'scripts/audit-provenance.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class AuditTest(unittest.TestCase):
    def test_scope_speaker_and_full_text_checked_without_writes_or_private_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'test.db'
            with sqlite3.connect(db) as c:
                c.executescript('CREATE TABLE messages(key,message_id,user_id,text,at,is_self);'
                                'CREATE TABLE memories(scope,source_id,subject_id,source_text,source_time,status);')
                c.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?)', [
                    ('private:1', 'same', '1', 'SECRET one', 2000, 0),
                    ('group:2', 'same', '3', 'SECRET two', 2000, 0),
                    ('private:1', 'bot', '1', 'SECRET bot', 2000, 1)])
                c.executemany('INSERT INTO memories VALUES(?,?,?,?,?,?)', [
                    ('private:1', 'same', '1', 'SECRET one', 2, 'active'),
                    ('private:1', 'same', '1', 'SECRET two', 2, 'candidate'),
                    ('group:2', 'same', '1', 'SECRET two', 2, 'active'),
                    ('private:1', 'bot', '1', 'SECRET bot', 2, 'active'),
                    ('private:1', 'gone', '1', 'SECRET missing', 2, 'active')])
            c.close()
            event_id = hashlib.sha256(b'private:1/same').hexdigest()[:24]
            (Path(tmp)/'self-reference.json').write_text(json.dumps({'claims':[{'evidence':[{'id':event_id,'quote':'SECRET one','at':9000}]}]}),encoding='utf-8')
            before = db.read_bytes()
            result = m.audit(db,tmp,'private:1')
            self.assertEqual(result['memorySources'], {'full_source_matches': 1, 'text_mismatch': 1,
                                                       'speaker_or_author_mismatch': 2, 'raw_unavailable': 1})
            self.assertEqual(before, db.read_bytes())
            self.assertNotIn('SECRET', json.dumps(result))
            self.assertEqual(result['modelCalls'], 0)
            self.assertEqual(result['bridgeEvidence']['self-reference.json:claims'], {'quote_found_not_full_validation':1})

    def test_missing_schema_fails_without_creating_tables(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'test.db'
            sqlite3.connect(db).close()
            before = db.read_bytes()
            with self.assertRaises(ValueError):
                m.audit(db)
            self.assertEqual(before, db.read_bytes())


if __name__ == '__main__':
    unittest.main()
