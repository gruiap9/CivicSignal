import json, math, sys
d = json.load(open(sys.argv[1]))
nodes = {e['id']: e for e in d['elements'] if e['type'] == 'node'}
ways = [e for e in d['elements'] if e['type'] == 'way' and 'name' in e.get('tags', {})]
signals = [n for n in nodes.values() if n.get('tags', {}).get('highway') == 'traffic_signals']
by_name = {}
for w in ways:
    by_name.setdefault(w['tags']['name'], set()).update(w['nodes'])
def dist(a, b):
    return math.hypot((a['lat'] - b['lat']) * 111320, (a['lon'] - b['lon']) * 111320 * math.cos(math.radians(42.36)))
targets = {
  'Binney Street and Fulkerson Street': ('Binney Street', 'Fulkerson Street'),
  'Broadway and Third Street': ('Broadway', 'Third Street'),
  'Cambridge St at First Street and N. First Street': ('Cambridge Street', 'First Street'),
  'Cambridge Street and Antrim Street': ('Cambridge Street', 'Antrim Street'),
  'Cambridge Street and Springfield Street': ('Cambridge Street', 'Springfield Street'),
  'First Street and Binney Street': ('First Street', 'Binney Street'),
  'First Street and Thorndike Street': ('First Street', 'Thorndike Street'),
  'Galileo Galilei Way and Broadway': ('Galileo Galilei Way', 'Broadway'),
  'Hampshire Street and Portland Street': ('Hampshire Street', 'Portland Street'),
  'Third Street and Binney Street': ('Third Street', 'Binney Street'),
  'Third Street and Cambridge Street': ('Third Street', 'Cambridge Street'),
  'Massachusetts Avenue and Vassar Street': ('Massachusetts Avenue', 'Vassar Street'),
}
out = {}
for k, (a, b) in targets.items():
    shared = by_name.get(a, set()) & by_name.get(b, set())
    if not shared:
        print(f'{k}: NOT FOUND in bbox ({a in by_name}, {b in by_name})'); continue
    pts = [nodes[i] for i in shared]
    lat = sum(p['lat'] for p in pts) / len(pts); lon = sum(p['lon'] for p in pts) / len(pts)
    c = {'lat': lat, 'lon': lon}
    sd = min(dist(c, s) for s in signals)
    out[k] = c
    print(f'{k:50s} {lat:.5f},{lon:.5f}  shared nodes={len(shared)}  nearest OSM signal {sd:.0f} m')
json.dump(out, open(sys.argv[2], 'w'), indent=1)
