"""Prepare and rehearse a migration on NEW files only. Never changes source DB.

python bin/migrate-evidence.py --source <database> --stage <new-empty-directory>
Optional --vectors uses the existing local embedding model in offline mode.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import time
from pathlib import Path
from contextlib import closing


def digest_tables(file):
    with closing(sqlite3.connect(file.resolve().as_uri()+'?mode=ro',uri=True)) as c:
        names=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        result={}
        for name in names:
            quoted='"'+name.replace('"','""')+'"'
            rows=c.execute('SELECT * FROM '+quoted).fetchall()
            digest=hashlib.sha256()
            for row in sorted(repr(r) for r in rows):digest.update(row.encode('utf-8'));digest.update(b'\n')
            result[name]={'rows':len(rows),'sha256':digest.hexdigest()}
        return result


def snapshot(source,target):
    with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)) as a,closing(sqlite3.connect(target)) as b:
        a.backup(b)
        assert b.execute('PRAGMA integrity_check').fetchone()[0]=='ok'


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',required=True,type=Path);p.add_argument('--stage',required=True,type=Path);p.add_argument('--vectors',action='store_true');p.add_argument('--reuse-vectors',type=Path);a=p.parse_args()
    source=a.source.resolve(strict=True);stage=a.stage.resolve()
    if stage.exists():raise SystemExit('stage must not exist; preserve earlier rehearsals')
    if stage==source.parent or source.parent in stage.parents:raise SystemExit('stage must be outside the source data directory')
    stage.mkdir(parents=True)
    rollback=stage/'rollback.db';candidate=stage/'candidate.db';snapshot(source,rollback);snapshot(rollback,candidate)
    before=digest_tables(rollback);started=time.monotonic()
    spec=importlib.util.spec_from_file_location('migration_server',Path(__file__).resolve().parents[1]/'memvec/server.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    m.DB_PATH=str(candidate);m.HOME=str(stage);m._strength_migrated=False
    # Neither get_model nor the HTTP server/main loop is invoked without --vectors.
    with m.db() as c:pass
    after=digest_tables(candidate)
    assert all(after[name]==value for name,value in before.items()),'original table changed'
    with m.db() as c:
        m.evidence_store.install(c,rebuild=True)
    with m.db() as c:
        c.commit();c.execute('BEGIN IMMEDIATE');m.evidence_store.install(c,rebuild=True);c.rollback()
    with m.db() as c:m.evidence_store.install(c,rebuild=True)
    # Interrupt SQL while rebuilding, then let SQLite roll back the entire change.
    with m.db() as c:
        before_count=c.execute('SELECT count(*) FROM evidence_fts').fetchone()[0]
        c.commit();c.execute('BEGIN IMMEDIATE');c.set_progress_handler(lambda:1,500)
        try:
            m.evidence_store.install(c,rebuild=True)
            raise AssertionError('fault injection did not interrupt migration')
        except sqlite3.OperationalError as error:
            assert 'interrupt' in str(error)
        finally:c.set_progress_handler(None,0);c.rollback()
        assert c.execute('SELECT count(*) FROM evidence_fts').fetchone()[0]==before_count
    report={'source':str(source),'stage':str(stage),'schema':m.evidence_store.SCHEMA,'originalTablesUnchanged':True,
        'originalTableDigests':before,'migrationSeconds':time.monotonic()-started,'rebuildTwice':True,'rollbackBeforeCommit':True,'interruptedDDLRecovery':True,'paidCalls':0}
    if a.reuse_vectors:
        with closing(sqlite3.connect(a.reuse_vectors.resolve(strict=True).as_uri()+'?mode=ro',uri=True)) as prior,m.db() as c:
            rows=prior.execute('SELECT * FROM evidence_vectors WHERE model=? AND dimensions>0 AND length(embedding)=dimensions*4',(m.MODEL,))
            c.executemany('''INSERT OR REPLACE INTO evidence_vectors SELECT ?,?,?,?
                WHERE EXISTS(SELECT 1 FROM evidence_source_lookup s WHERE s.source_version=?)''',(tuple(row)+(row[0],) for row in rows))
            report['reusedVectors']=c.execute('SELECT count(*) FROM evidence_vectors').fetchone()[0]
    if a.vectors:
        os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';m.get_model()
        indexed=0;start=time.monotonic()
        while True:
            r=m.index_evidence(128);indexed+=r['indexed']
            if not r['indexed']:break
            print(json.dumps({'indexed':indexed,'elapsedSeconds':round(time.monotonic()-start,2)}),flush=True)
        report['embedding']={'indexed':indexed,'seconds':time.monotonic()-start,'model':m.MODEL,'paidCalls':0}
    with m.db() as c:
        report['integrity']=c.execute('PRAGMA integrity_check').fetchone()[0]
        report['indexedOriginals']=c.execute('SELECT count(*) FROM evidence_fts').fetchone()[0]
        report['retainedOriginals']=c.execute('SELECT count(DISTINCT source_version) FROM evidence_source_lookup WHERE length(source_version)=64').fetchone()[0]
        report['vectorCount']=c.execute('SELECT count(*) FROM evidence_vectors WHERE model=?',(m.MODEL,)).fetchone()[0]
    assert report['integrity']=='ok';assert report['indexedOriginals']==report['retainedOriginals']
    final=digest_tables(candidate)
    assert all(final[name]==value for name,value in before.items()),'indexing changed original table'
    restored=stage/'rollback-rehearsal.db';snapshot(rollback,restored);assert digest_tables(restored)==before
    report['rollbackCopyVerified']=True
    # A ready-to-review plan, not an instruction executed against production.
    (stage/'migration-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='originalTableDigests'},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
