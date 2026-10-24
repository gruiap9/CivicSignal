import json, sys, urllib.parse, urllib.request
CLUSTER = ['Broadway and Third Street', 'Galileo Galilei Way and Broadway', 'Binney Street and Fulkerson Street', 'Third Street and Binney Street',
           'First Street and Binney Street', 'First Street and Thorndike Street', 'Cambridge St at First Street and N. First Street', 'Third Street and Cambridge Street']
names = ",".join("'" + c + "'" for c in CLUSTER)
where = f"intersection in ({names}) AND class != 'Bicycle' AND timebin between '2026-10-13T00:00:00' and '2026-10-15T23:45:00'"
q = {'$select': 'intersection,timebin,entrance,exit,sum(qty) as q', '$where': where, '$group': 'intersection,timebin,entrance,exit', '$limit': '200000'}
url = 'https://data.cambridgema.gov/resource/jwtp-n65u.json?' + urllib.parse.urlencode(q)
rows = json.load(urllib.request.urlopen(url, timeout=120))
json.dump(rows, open(sys.argv[1], 'w'))
print(len(rows), 'rows')
