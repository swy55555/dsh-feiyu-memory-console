"""Local HTTP fixture using real storage/handlers, with deterministic embeddings."""
import importlib.util
import json
import sys
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('memory_server', Path(__file__).resolve().parents[1] / 'memvec/server.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.DB_PATH = sys.argv[1]
m._owner_scope_cache = 'private:10001'
m.embed = lambda texts: np.array([[1., 0., 0.] for _ in texts], dtype=np.float32)
def fact(value, evidence):
    return {'object':'coffee','attribute':'preference','value':value,'condition':'','timeframe':'','cardinality':'single','evidence':evidence}
old = m.add_memory('I like coffee', fact=fact('like','I like coffee'), scope='private:10001', subject_id='10001', fact_key='drink', confirmed=True, source_time=m.now()-100)
new = m.add_memory('I no longer drink coffee', fact=fact('avoid','I no longer drink coffee'), scope='private:10001', subject_id='10001', fact_key='drink', source_time=m.now(), source_id='message-2', source_text='<img src=x onerror=alert(1)> original user wording')
group = m.add_memory('group fact', scope='group:20001', subject_id='20002', confirmed=True)
server = m.ThreadingHTTPServer(('127.0.0.1', 0), m.Handler)
print(json.dumps({'port': server.server_address[1], 'old': old['id'], 'new': new['id'], 'group': group['id']}), flush=True)
server.serve_forever()
