import json, os, sys, tempfile, threading, urllib.request
from http.server import ThreadingHTTPServer

tmp = tempfile.mkdtemp(prefix='memvec-p0-')
os.environ['MEMVEC_DB_PATH'] = os.path.join(tmp, 'memories.db')
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', 'memvec'))
import server

key = 'private:1936396478'

# 1. 幂等写入：同一 messageId 写两次只留一条
server.add_message(key=key, message_id='m1', sender='老大', user_id='1936396478', text='今天想做番茄炒蛋', at=1000)
server.add_message(key=key, message_id='m1', sender='老大', user_id='1936396478', text='今天想做番茄炒蛋', at=1000)
server.add_message(key=key, message_id='m2', sender='我', user_id='', text='好啊，需要我帮你记火候吗', at=2000, is_self=True)

rows = server.context_messages(key=key, limit=10, budget_chars=1000)
assert len(rows) == 2, rows
assert rows[0]['text'].startswith('今天想做'), rows
assert rows[1]['is_self'] == 1, rows

# 2. beforeAt 过滤当前消息
rows2 = server.context_messages(key=key, limit=10, budget_chars=1000, before_at=2000)
assert len(rows2) == 1 and rows2[0]['message_id'] == 'm1', rows2

# 3. 字符预算：单条超预算时截断但保留，不整段消失
long_key = 'private:42'
server.add_message(key=long_key, message_id='L1', sender='老大', text='长' * 900, at=4000)
rows3 = server.context_messages(key=long_key, limit=10, budget_chars=500)
assert len(rows3) == 1 and rows3[0]['message_id'] == 'L1', rows3
assert len(rows3[0]['text']) < 900, len(rows3[0]['text'])

# 4. HTTP 路由
srv = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

def post(path, payload):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(payload).encode(),
                                 headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())

r = post('/context', {'key': key, 'limit': 10, 'budgetChars': 1000})
assert r['ok'] and r['count'] == 2, r
r = post('/message', {'key': key, 'message_id': 'm3', 'sender': '老大', 'text': '再来一条', 'at': 3000})
assert r['ok'], r

# 4b. 桥接发的是 camelCase，必须同样接受
r = post('/message', {'key': key, 'messageId': 'm4', 'sender': '老大', 'userId': '1936396478', 'text': '驼峰参数', 'at': 3500, 'isSelf': False})
assert r['ok'], r
ctx_camel = post('/context', {'key': key, 'limit': 10, 'budgetChars': 2000})
assert any(m['message_id'] == 'm4' for m in ctx_camel['messages']), ctx_camel

# 4c. 摘要要按“最早的一批”收，否则消息超过 400 条时会漏掉开头
first_two = post('/messages', {'key': key, 'limit': 2, 'oldestFirst': True})['messages']
assert [m['message_id'] for m in first_two] == ['m1', 'm2'], first_two
latest_two = post('/messages', {'key': key, 'limit': 2})['messages']
assert [m['message_id'] for m in latest_two] == ['m3', 'm4'], latest_two

# 5. 摘要：写入、按 period_end 裁剪原文、删除
summary = post('/summary', {
    'key': key, 'period_start': 0, 'period_end': 1500,
    'covered_ids': ['m1'], 'text': '前段摘要：想做番茄炒蛋', 'structured': '{"topics":["做饭"]}',
    'model': 'test'
})
assert summary['ok'] and summary['id'], summary
stats = post('/context/stats', {'key': key})
assert stats['messages'] == 4 and stats['summaries'] == 1, stats
assert stats['last_summary_end'] == 1500, stats

ctx = post('/context', {'key': key, 'limit': 10, 'budgetChars': 2000})
assert ctx['count'] == 3, ctx  # m2/m3/m4，m1 已被摘要覆盖
assert len(ctx['summaries']) == 1 and ctx['summaries'][0]['text'].startswith('前段摘要'), ctx

listed = post('/summaries', {'key': key, 'limit': 10})
assert len(listed['summaries']) == 1, listed
assert listed['summaries'][0]['value'] == 1 and listed['summaries'][0]['kind'] == 'summary', listed

deleted = post('/summary/delete', {'key': key, 'id': summary['id']})
assert deleted['changed'] == 1, deleted
assert len(post('/summaries', {'key': key, 'limit': 10})['summaries']) == 0

# 低信息量 / 仅覆盖：value 0，仍保留 period_end 用来挡原文。
cov = server.add_summary(key=key, period_start=1500, period_end=2000, text='（这段只有简短闲聊）', value=0, kind='coverage')
assert cov['value'] == 0 and cov['kind'] == 'coverage', cov
rows = server.list_summaries(key)
assert len(rows) == 1 and rows[0]['value'] == 0 and rows[0]['kind'] == 'coverage', rows
assert server.latest_summary_end(key) == 2000
server.delete_summary(key, cov['id'])
assert len(server.list_summaries(key)) == 0

srv.shutdown()

st = server.stats()
assert st['messages'] == 5, st
assert st['summaries'] == 0, st
print('P0 memvec tests OK', st['messages'])
