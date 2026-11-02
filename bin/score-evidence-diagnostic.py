"""Post-retrieval source-label diagnostic. Never imports a product or model module."""
import argparse,json,sqlite3
from contextlib import closing
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--old',required=True,type=Path);p.add_argument('--run',required=True,type=Path);a=p.parse_args()
rows=[json.loads(x) for x in (a.run/'retrieval.jsonl').read_text('utf-8').splitlines()];ids={r['id'] for r in rows};labels={}
for line in (a.old/'review-only/answers.jsonl').read_text('utf-8').splitlines():
    # Only already-frozen development questions enter this diagnostic.
    if not any(('"id": "'+id+'"') in line for id in ids):continue
    r=json.loads(line);labels[r['id']]=r.get('evidence',[])
details=[]
for row in rows:
    expected=set(labels[row['id']]);got={r['sourceId'] for r in row['adopted']};available=set()
    with closing(sqlite3.connect((a.run/(row['sampleId']+'.db')).resolve().as_uri()+'?mode=ro',uri=True)) as c:
        for id in expected:
            if c.execute('SELECT 1 FROM evidence_source_lookup WHERE message_id=? LIMIT 1',(id,)).fetchone():available.add(id)
    details.append({'id':row['id'],'labelCount':len(expected),'available':len(available),'hit':len(expected&got),'allHit':bool(expected) and expected<=got})
eligible=[r for r in details if r['labelCount']]
report={'questions':len(rows),'withSourceLabels':len(eligible),'anySourceAvailable':sum(r['available']>0 for r in eligible),'allSourcesAvailable':sum(r['available']==r['labelCount'] for r in eligible),'anyLabelHit':sum(r['hit']>0 for r in eligible),'allLabelsHit':sum(r['allHit'] for r in eligible),'answerAccuracy':None,'interpretation':'Source-label hits are neither semantic correctness nor full-agent answer accuracy. Only one retrieval; no autonomous follow-up or review.'}
(a.run/'source-label-diagnostic.json').write_text(json.dumps({'summary':report,'questions':details},indent=2),'utf-8');print(json.dumps(report))
