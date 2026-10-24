import json, sys
d = json.load(open(sys.argv[1])); sens = json.load(open(sys.argv[2])); tmc = json.load(open(sys.argv[3]))['tmc']
nodes = {e['id']: e for e in d['elements'] if e['type'] == 'node' and 'lat' in e}
ways = [e for e in d['elements'] if e['type'] == 'way' and 'name' in e.get('tags', {})]
LAT0, LAT1, LON0, LON1 = 42.3605, 42.3725, -71.0925, -71.0745
W = 520; SC = W / ((LON1 - LON0) * 82200); H = (LAT1 - LAT0) * 111320 * SC
X = lambda lon: 40 + (lon - LON0) * 82200 * SC
Y = lambda lat: 30 + (LAT1 - lat) * 111320 * SC
CL = {'Binney Street', 'Third Street', 'First Street', 'Cambridge Street', 'Broadway', 'Galileo Galilei Way', 'Fulkerson Street'}
out = []
for w in ways:
    pts = [nodes[n] for n in w['nodes'] if n in nodes]
    if len(pts) < 2: continue
    hw = w['tags'].get('highway', '')
    if w['tags']['name'] not in CL and hw not in ('primary', 'secondary', 'tertiary', 'trunk'): continue
    xy = [(round(X(n['lon'])), round(Y(n['lat']))) for n in pts]
    xy = [q for i, q in enumerate(xy) if i == 0 or q != xy[i - 1]]
    if len(xy) < 2 or all(not (0 <= x <= 680 and 0 <= y <= 700) for x, y in xy): continue
    p = ' '.join(f'{x},{y}' for x, y in xy)
    if w['tags']['name'] in CL:
        out.append(f'<polyline points="{p}" fill="none" stroke="var(--text-secondary)" stroke-width="2.5" stroke-linecap="round" opacity="0.55"/>')
    else:
        out.append(f'<polyline points="{p}" fill="none" stroke="var(--border-strong)" stroke-width="0.8"/>')
by = {}
for w in ways: by.setdefault(w['tags']['name'], set()).update(w['nodes'])
def at(a, b):
    s = by.get(a, set()) & by.get(b, set())
    pts = [nodes[i] for i in s if i in nodes]
    return (sum(p['lat'] for p in pts) / len(pts), sum(p['lon'] for p in pts) / len(pts)) if pts else None
uns = [('Binney Street', 'Sixth Street'), ('Binney Street', 'Second Street'), ('Third Street', 'Charles Street'), ('First Street', 'Charles Street'),
       ('Cambridge Street', 'Second Street'), ('Cambridge Street', 'Sixth Street'), ('Broadway', 'Ames Street'), ('Binney Street', 'Edwin H. Land Boulevard')]
for a, b in uns:
    c = at(a, b)
    if c: out.append(f'<circle cx="{X(c[1]):.1f}" cy="{Y(c[0]):.1f}" r="5" fill="var(--surface-1)" stroke="var(--text-secondary)" stroke-width="1.5"/>')
short = {'Binney Street and Fulkerson Street': ('Binney / Galileo', 'l'), 'Broadway and Third Street': ('Broadway / Third', 'r'),
         'Cambridge St at First Street and N. First Street': ('Cambridge / First', 'r'), 'First Street and Binney Street': ('Binney / First', 'r'),
         'First Street and Thorndike Street': ('First / Thorndike', 'r'), 'Galileo Galilei Way and Broadway': ('Broadway / Galileo', 'l'),
         'Third Street and Binney Street': ('Binney / Third', 'l'), 'Third Street and Cambridge Street': ('Cambridge / Third', 'l')}
for k, (lab, side) in short.items():
    c = sens[k]; x, y = X(c['lon']), Y(c['lat']); tot = sum(tmc[k].values())
    out.append(f'<circle class="c-teal" cx="{x:.1f}" cy="{y:.1f}" r="8" stroke-width="1"/>')
    tx = x + 14 if side == 'r' else x - 14; anc = 'start' if side == 'r' else 'end'
    out.append(f'<text class="th" x="{tx:.1f}" y="{y - 3:.1f}" text-anchor="{anc}">{lab}</text>')
    out.append(f'<text class="ts" x="{tx:.1f}" y="{y + 13:.1f}" text-anchor="{anc}">{tot:,.0f} veh/h</text>')
Hh = int(30 + H + 70)
ly = int(30 + H + 30)
legend = (f'<circle class="c-teal" cx="52" cy="{ly}" r="8" stroke-width="1"/><text class="ts" x="66" y="{ly+4}">Sensor (5 PM peak hour, all movements)</text>'
          f'<circle cx="360" cy="{ly}" r="5" fill="var(--surface-1)" stroke="var(--text-secondary)" stroke-width="1.5"/><text class="ts" x="372" y="{ly+4}">Signal without sensor</text>')
svg = (f'<svg width="100%" viewBox="0 0 680 {Hh}" role="img"><title>Kendall Square sensor network</title>'
       f'<desc>Map of eight Cambridge traffic sensors in Kendall and East Cambridge, their 5 PM peak-hour volumes, and signalized intersections between them without sensors.</desc>'
       + ''.join(out) + legend + '</svg>')
open(sys.argv[4], 'w').write(svg); print(len(svg), 'bytes, H=', Hh)
