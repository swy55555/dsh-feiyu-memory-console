"""Scope-local lexical ranking. No question labels, learned benchmark rules or model calls."""
import math
import re
from collections import Counter, OrderedDict, defaultdict
from hashlib import sha256

STOP = frozenset('a an the and or but of for from to in on at with by as it its they their them we our us i me my you your he him his she her s what when where which who why how does do did has have had is are was were be been being would could should can will about during'.split())

def word(token):
    # Conservative inflection normalization; token boundaries prevent art/party.
    if not re.fullmatch('[a-z]+',token):return token
    if len(token)>5 and token.endswith('ies'):return token[:-3]+'y'
    if len(token)>4 and token.endswith('s') and not token.endswith(('ss','us','is')):token=token[:-1]
    if len(token)>6 and token.endswith('ing'):
        token=token[:-3]
        if len(token)>2 and token[-1]==token[-2]:token=token[:-1]
    elif len(token)>5 and token.endswith('ed'):token=token[:-2]
    return token

def tokens(text):
    out=[]
    for chunk in re.findall(r'[\u3400-\u9fff]+|[a-z0-9]+',str(text).casefold()):
        if re.search(r'[\u3400-\u9fff]',chunk):
            out.extend(chunk[i:i+2] for i in range(len(chunk)-1))
            if len(chunk)==1:out.append(chunk)
        elif len(chunk)>1 and chunk not in STOP:out.append(word(chunk))
    return out

_corpora=OrderedDict()

def corpus(rows,cache_key):
    # No raw bodies are cached. A scope/version/name snapshot changes on deletion,
    # correction or attribution changes; never reuse another database's corpus.
    fingerprint=sha256()
    for r in rows:fingerprint.update((r['source_version']+'\0'+str(r.get('sender',''))+'\n').encode())
    signature=fingerprint.digest();old=_corpora.get(cache_key)
    if old and old[0]==signature:
        _corpora.move_to_end(cache_key);return old[1]
    prior=old[1][0] if old else {}
    docs={r['source_version']:prior[r['source_version']] if r['source_version'] in prior and prior[r['source_version']][1]==str(r.get('sender','')).casefold()
          else (Counter(tokens(r['text'])),str(r.get('sender','')).casefold()) for r in rows}
    postings=defaultdict(set);lengths={}
    for version,(counts,_) in docs.items():
        lengths[version]=sum(counts.values())
        for term in counts:postings[term].add(version)
    value=(docs,postings,lengths)
    _corpora.pop(cache_key,None)
    if len(docs)<=12000 and sum(len(c) for c,_ in docs.values())<=1000000:
        _corpora[cache_key]=(signature,value)
        while len(_corpora)>2 or sum(len(v[1][0]) for v in _corpora.values())>12000 or sum(sum(len(c) for c,_ in v[1][0].values()) for v in _corpora.values())>1000000:_corpora.popitem(last=False)
    return value

class ScopedLexical:
    def __init__(self, rows, query, cache_key=None):
        self.docs,self.postings,self.lengths=corpus(rows,cache_key)
        names={name for _,name in self.docs.values() if name and len(name)<=80}
        self.names={name for name in names if (len(name)>=2 and re.search(r'[\u3400-\u9fff]',name) and name in query.casefold()) or re.search(r'(?<!\w)'+re.escape(name)+r'(?!\w)',query.casefold())}
        name_tokens={t for n in self.names for t in tokens(n)}
        self.terms=list(dict.fromkeys(t for t in tokens(query) if t not in name_tokens))[:32]
        self.df={t:len(self.postings.get(t,())) for t in self.terms}
        self.n=max(1,len(self.docs));self.avg=max(1,sum(self.lengths.values())/self.n)
        self.weights={t:math.log(1+(self.n-self.df[t]+.5)/(self.df[t]+.5)) for t in self.terms if self.df[t]}

    def score(self,version,text='',sender=''):
        found=self.docs.get(version)
        counts,name=found if found else (Counter(tokens(text)),sender.casefold())
        matched=[t for t in self.weights if counts[t]];total=sum(self.weights.values()) or 1
        coverage=sum(self.weights[t] for t in matched)/total
        length=self.lengths[version] if found else sum(counts.values());bm=sum(self.weights[t]*counts[t]*2.2/(counts[t]+1.2*(.25+.75*length/self.avg)) for t in matched)
        lexical=.65*coverage+.2*bm/(bm+2)
        return {'lexical':lexical,'coverage':coverage,'bm25':bm,'speakerMatch':bool(self.names and name in self.names),'matchedTerms':matched}

    def candidates(self):
        candidates=set().union(*(self.postings.get(t,set()) for t in self.terms))
        scored=[(v,self.score(v)) for v in candidates]
        return sorted(((v,s) for v,s in scored if s['matchedTerms']),key=lambda x:(-x[1]['lexical']-.08*x[1]['speakerMatch'],x[0]))[:120]
