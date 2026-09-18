
import json,re,urllib.parse,sys
har=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'flow.har'))
for i,e in enumerate(har['log']['entries']):
    u=e['request']['url']
    if 'batchexecute' not in u: continue
    rid=re.search(r'rpcids=([^&]+)',u).group(1)
    post=e['request'].get('postData',{}).get('text','') or ''
    m=re.search(r'f\.req=([^&]*)',post)
    raw=urllib.parse.unquote_plus(urllib.parse.unquote(m.group(1))) if m else ''
    try: nice=json.loads(raw)[0][0][1]
    except Exception: nice=''
    print(f"[{i}] {rid} {e['request']['method']} :: {nice[:200]}")
