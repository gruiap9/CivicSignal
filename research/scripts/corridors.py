import json, math, sys
d = json.load(open(sys.argv[1])); ctl = json.load(open(sys.argv[2]))['elements']; sens = json.load(open(sys.argv[3]))
nodes = {e['id']: e for e in d['elements'] if e['type'] == 'node' and 'lat' in e}
ways = [e for e in d['elements'] if e['type'] == 'way' and 'name' in e.get('tags', {})]
sig = [n for n in ctl if n.get('tags', {}).get('highway') == 'traffic_signals' or n.get('tags', {}).get('crossing') == 'traffic_signals']
def dist(a, b):
    return math.hypot((a['lat'] - b['lat']) * 111320, (a['lon'] - b['lon']) * 111320 * math.cos(math.radians(42.36)))
names_at = {}
for w in ways:
    for nid in w['nodes']:
        names_at.setdefault(nid, set()).add(w['tags']['name'])
STREETS = sys.argv[4].split(',')
for st in STREETS:
    nids = {nid for w in ways if w['tags']['name'] == st for nid in w['nodes'] if nid in nodes}
    # junctions with other named streets
    js = [(nid, names_at[nid] - {st}) for nid in nids if len(names_at[nid] - {st}) > 0]
    pts = [nodes[n] for n in nids]
    # order along principal axis
    la = sum(p['lat'] for p in pts) / len(pts); lo = sum(p['lon'] for p in pts) / len(pts)
    xs = [((p['lon'] - lo) * 82200, (p['lat'] - la) * 111320) for p in pts]
    sxx = sum(x * x for x, y in xs); syy = sum(y * y for x, y in xs); sxy = sum(x * y for x, y in xs)
    ang = 0.5 * math.atan2(2 * sxy, sxx - syy); ux, uy = math.cos(ang), math.sin(ang)
    proj = lambda p: (p['lon'] - lo) * 82200 * ux + (p['lat'] - la) * 111320 * uy
    merged = {}
    for nid, others in js:
        key = tuple(sorted(others))
        p = nodes[nid]; s = proj(p)
        merged.setdefault(key, []).append((s, p))
    rows = []
    for key, lst in merged.items():
        s = sum(x for x, _ in lst) / len(lst); p = lst[0][1]
        signal = min((dist(p, q) for q in sig), default=999) < 20
        sensor = next((k for k, c in sens.items() if dist(c, p) < 40 and st.split()[0] in k), None)
        rows.append((s, '/'.join(key), signal, sensor))
    rows.sort()
    print(f'\n### {st}  (axis {math.degrees(ang):.0f}°)')
    last = None
    for s, nm, signal, sensor in rows:
        if not (signal or sensor): continue
        gap = f'+{s - last:4.0f} m' if last is not None else '      '
        last = s
        print(f'  {gap}  {"SENSOR " if sensor else "       "}{"signal" if signal else "  -   "}  x {nm}')
