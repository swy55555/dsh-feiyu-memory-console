"""Question-only retrieval diagnostic: no answer labels, provider or QQ connection.

Copies five development DBs. Output is retrieval metadata, never answer accuracy.
Requires the already-installed local embedding model in the specified cache.
"""
import argparse, importlib.util, json, os, sqlite3, time, hashlib
from pathlib import Path
from contextlib import closing

def main():
    p=argparse.ArgumentParser();p.add_argument('--old',required=True,type=Path);p.add_argument('--dev',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--cache',required=True,type=Path);a=p.parse_args()
    if a.out.exists():raise SystemExit('preserve existing runs; out must be new')
    questions_bytes=(a.dev/'questions.jsonl').read_bytes();protocol=json.loads((a.dev/'protocol.json').read_text('utf-8'))
    assert hashlib.sha256(questions_bytes).hexdigest()==protocol['sampleSha256']
    questions=[json.loads(x) for x in questions_bytes.decode().splitlines()]
    assert len(questions)==100 and {q['sampleId'] for q in questions}=={'conv-26','conv-30','conv-41','conv-42','conv-43'}
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',MEMVEC_CACHE_PATH=str(a.cache.resolve()))
    spec=importlib.util.spec_from_file_location('offline_server',Path(__file__).resolve().parents[1]/'memvec/server.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    a.out.mkdir(parents=True);m.get_model();records=[];groups=[]
    for sid in sorted({q['sampleId'] for q in questions}):
        source=a.old/'runs/native-v3'/sid/'memories.db';target=a.out/(sid+'.db')
        with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)) as old,closing(sqlite3.connect(target)) as dst:old.backup(dst)
        at=json.loads((source.parent/'prepared.json').read_text('utf-8'))['at'];m.now=lambda:at/1000;m.DB_PATH=str(target.resolve());m.HOME=str(a.out.resolve());m._strength_migrated=False
        with m.db() as c:
            scopes=[r[0] for r in c.execute('SELECT DISTINCT key FROM messages')];assert len(scopes)==1;scope=scopes[0]
        start=time.monotonic();indexed=0
        while True:
            result=m.index_evidence(128);indexed+=result['indexed']
            if not result['indexed']:break
        groups.append({'sampleId':sid,'indexed':indexed,'indexSeconds':time.monotonic()-start})
        for q in [q for q in questions if q['sampleId']==sid]:
            start=time.monotonic();result=m.search_evidence({'scope':scope,'query':q['question'],'at':at,'limit':8})
            # Same whole-record budget as runtime; no answer/evidence labels enter selection.
            adopted=[];chars=0
            for row in result['results']:
                size=len(json.dumps(row,ensure_ascii=False))
                if chars+size>6000:continue
                adopted.append(row);chars+=size
            records.append({'id':q['id'],'sampleId':sid,'elapsedMs':round((time.monotonic()-start)*1000,2),'vectorStatus':result['vectorStatus'],'calls':1,'chars':chars,'returned':len(result['results']),
                'adopted':[{'id':r['id'],'sourceId':r['contract'].get('messageId') or r['contract'].get('sourceId'),'roots':r['contract']['rootIds'],'type':r['contract']['sourceType']} for r in adopted]})
        print(json.dumps({'sampleId':sid,'questionsDone':len(records),'indexed':indexed}),flush=True)
    elapsed=sorted(r['elapsedMs'] for r in records)
    report={'protocol':1,'questions':len(records),'paidCalls':0,'answerCalls':0,'judgeCalls':0,'autoCandidateReview':False,'summariesGenerated':False,'model':m.MODEL,'groups':groups,'nonempty':sum(bool(r['adopted']) for r in records),'vectorReady':sum(r['vectorStatus']=='ready' for r in records),'retrievalP50Ms':elapsed[len(elapsed)//2],'retrievalP95Ms':elapsed[int(len(elapsed)*.95)-1],'scope':'one initial hybrid retrieval with bounded whole-record projection; not full tool-agent answer evaluation','sampleSha256':protocol['sampleSha256']}
    (a.out/'retrieval.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in records),'utf-8');(a.out/'summary.json').write_text(json.dumps(report,indent=2),'utf-8');print(json.dumps(report),flush=True)

if __name__=='__main__':main()
