"""Build the CivicSignal Kendall / East Cambridge scenario from OpenStreetMap + City of Cambridge counts.

Usage:
  python3 scripts/build_kendall.py <osm_dir> <out_json>

<osm_dir> must contain kendall.json and control.json (see fetch_osm.sh). Count data is read from data/.
Everything that is measured vs. modeled is recorded in the output so the app can label it.
"""
import heapq
import json
import math
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
osm_dir, out_path = sys.argv[1], sys.argv[2]

LAT0 = 42.3665
KX = 111320 * math.cos(math.radians(LAT0))
KY = 111320
GRID_TILT = 16.0  # degrees: Kendall streets run ~16° clockwise of true north/east
UTC_OFFSET = 4  # EDT in October
BOX_R = 30  # m: OSM nodes within this radius on the two streets belong to the junction
BOUNDARY_LEN = 120  # m: length of modeled entry/exit links leaving the network

# Signalized intersections in the model. sensor = dataset name or None.
SIGNALS = [
    ('C3', 'Cambridge Street', 'Third Street', 'Cambridge St & Third St', 'Third Street and Cambridge Street'),
    ('C2', 'Cambridge Street', 'Second Street', 'Cambridge St & Second St', None),
    ('C1', 'Cambridge Street', 'First Street', 'Cambridge St & First St', 'Cambridge St at First Street and N. First Street'),
    ('T1', 'First Street', 'Thorndike Street', 'First St & Thorndike St', 'First Street and Thorndike Street'),
    ('H3', 'Third Street', 'Charles Street', 'Third St & Charles St', None),
    ('H1', 'First Street', 'Charles Street', 'First St & Charles St', None),
    ('B3', 'Binney Street', 'Third Street', 'Binney St & Third St', 'Third Street and Binney Street'),
    ('B2', 'Binney Street', 'Second Street', 'Binney St & Second St', None),
    ('B1', 'Binney Street', 'First Street', 'Binney St & First St', 'First Street and Binney Street'),
    ('R3', 'Broadway', 'Third Street', 'Broadway & Third St', 'Broadway and Third Street'),
]
# Unsensored signal, upstream sensor, downstream sensor, travel heading (grid frame).
FLOW_BALANCE = [
    ('H1', 'B1', 'T1', 'N'), ('H1', 'T1', 'B1', 'S'),
    ('H3', 'B3', 'C3', 'N'), ('H3', 'C3', 'B3', 'S'),
    ('B2', 'B3', 'B1', 'E'), ('B2', 'B1', 'B3', 'W'),
    ('C2', 'C3', 'C1', 'E'), ('C2', 'C1', 'C3', 'W'),
]
ROAD_TYPES = {'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'trunk', 'primary_link', 'secondary_link', 'tertiary_link'}

osm = json.load(open(os.path.join(osm_dir, 'kendall.json')))
nodes = {e['id']: e for e in osm['elements'] if e['type'] == 'node' and 'lat' in e}
ways = [e for e in osm['elements'] if e['type'] == 'way' and e.get('tags', {}).get('highway') in ROAD_TYPES and 'name' in e['tags']]


def xy(lat, lon):
    return ((lon - (-71.083)) * KX, (LAT0 - lat) * KY)


def mph(v):
    try:
        return float(v.split()[0]) * 0.44704
    except Exception:
        return None


# ---- directed OSM street graph ----
edges = defaultdict(list)  # u -> [(v, length, name, lanes_dir, speed)]
names_at = defaultdict(set)
for w in ways:
    t = w['tags']
    ow = t.get('oneway', 'no')
    lanes = int(t.get('lanes', '2').split(';')[0])
    lf = int(t.get('lanes:forward', lanes if ow in ('yes', '1', 'true') else max(1, lanes // 2)))
    lb = int(t.get('lanes:backward', max(1, lanes - lf) if ow not in ('yes', '1', 'true') else 0))
    sp = mph(t.get('maxspeed', '25 mph')) or 11.2
    seq = [n for n in w['nodes'] if n in nodes]
    for n in seq:
        names_at[n].add(t['name'])
    for a, b in zip(seq, seq[1:]):
        pa, pb = nodes[a], nodes[b]
        L = math.hypot((pa['lon'] - pb['lon']) * KX, (pa['lat'] - pb['lat']) * KY)
        if ow != '-1':
            edges[a].append((b, L, t['name'], lf, sp))
        if ow not in ('yes', '1', 'true'):
            edges[b].append((a, L, t['name'], lb if ow != '-1' else lanes, sp))

# ---- junction node sets ----
by_name = defaultdict(set)
for w in ways:
    by_name[w['tags']['name']].update(n for n in w['nodes'] if n in nodes)
junction = {}
centre = {}
for sid, a, b, label, sensor in SIGNALS:
    shared = by_name[a] & by_name[b]
    if not shared:
        sys.exit(f'{sid}: {a} and {b} do not meet in OSM')
    lat = sum(nodes[n]['lat'] for n in shared) / len(shared)
    lon = sum(nodes[n]['lon'] for n in shared) / len(shared)
    centre[sid] = (lat, lon)
    cx, cy = xy(lat, lon)
    J = {n for n in (by_name[a] | by_name[b]) if math.hypot(*(p - q for p, q in zip(xy(nodes[n]['lat'], nodes[n]['lon']), (cx, cy)))) <= BOX_R}
    junction[sid] = J | shared
owner = {}
for sid, J in junction.items():
    for n in J:
        owner[n] = sid


def side_of(dx, dy):
    """Snap a direction (x east, y south) to N/E/S/W in the tilted street grid."""
    ang = math.degrees(math.atan2(dx, -dy))  # bearing from north, clockwise
    ang = (ang - GRID_TILT) % 360
    return 'NESW'[int(((ang + 45) % 360) // 90)]


# ---- links between signals along shared streets (Dijkstra restricted to that street) ----
sig_by_id = {s[0]: s for s in SIGNALS}
links = []
for u, ua, ub, *_ in SIGNALS:
    for v, va, vb, *_ in SIGNALS:
        if u == v:
            continue
        common = {ua, ub} & {va, vb}
        for st in common:
            dist = {n: 0.0 for n in junction[u]}
            info = {}
            pq = [(0.0, n) for n in junction[u]]
            found = None
            while pq:
                d, n = heapq.heappop(pq)
                if d > dist.get(n, 1e18) or d > 700:
                    continue
                if n in junction[v]:
                    found = n
                    break
                if n in owner and owner[n] not in (u, v) and n not in junction[u]:
                    continue  # passes through another modeled signal
                for m, L, name, ln, sp in edges[n]:
                    if name != st:
                        continue
                    nd = d + L
                    if nd < dist.get(m, 1e18):
                        dist[m] = nd
                        info[m] = (n, ln, sp)
                        heapq.heappush(pq, (nd, m))
            if found is None:
                continue
            lanes, speeds, n = [], [], found
            while n in info:
                p, ln, sp = info[n]
                lanes.append(ln)
                speeds.append(sp)
                n = p
            (lu, ou), (lv, ov) = centre[u], centre[v]
            ux, uy = xy(lu, ou)
            vx, vy = xy(lv, ov)
            # lanes[0] is the edge arriving at v's stop line, which sets approach capacity.
            links.append({'from': u, 'to': v, 'street': st, 'pathLength': round(dist[found], 1),
                          'lanes': max(1, lanes[0]), 'vf': round(min(speeds), 2), 'heading': side_of(vx - ux, vy - uy)})

# ---- boundary legs: OSM edges leaving each junction on a side with no modeled neighbour ----
boundary = []
for sid, a, b, label, sensor in SIGNALS:
    cx, cy = xy(*centre[sid])
    internal_out = {l['heading'] for l in links if l['from'] == sid}
    internal_in = {l['heading'] for l in links if l['to'] == sid}  # heading of travel INTO sid
    opp = {'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E'}
    internal_in_sides = {opp[h] for h in internal_in}
    sides = defaultdict(lambda: {'in': [], 'out': [], 'names': set()})
    for n in junction[sid]:
        for m, L, name, ln, sp in edges[n]:
            if m in junction[sid]:
                continue
            mx, my = xy(nodes[m]['lat'], nodes[m]['lon'])
            s = side_of(mx - cx, my - cy)
            sides[s]['out'].append((ln, sp))
            sides[s]['names'].add(name)
        # incoming edges: from m (outside) into n
    for m0, lst in edges.items():
        if m0 in junction[sid]:
            continue
        for n, L, name, ln, sp in lst:
            if n in junction[sid]:
                mx, my = xy(nodes[m0]['lat'], nodes[m0]['lon'])
                s = side_of(mx - cx, my - cy)
                sides[s]['in'].append((ln, sp))
                sides[s]['names'].add(name)
    internal_sides = internal_out | internal_in_sides
    for s, d in sides.items():
        name = '/'.join(sorted(d['names']))
        if s in internal_sides:
            continue  # a modeled link already occupies this side of the junction
        if d['out']:
            boundary.append({'signal': sid, 'side': s, 'dir': 'exit', 'street': name, 'lanes': max(x[0] for x in d['out']), 'vf': round(min(x[1] for x in d['out']), 2)})
        if d['in']:
            boundary.append({'signal': sid, 'side': s, 'dir': 'entry', 'street': name, 'lanes': max(x[0] for x in d['in']), 'vf': round(min(x[1] for x in d['in']), 2)})

# ---- sanity: one out-link per side per signal ----
for sid, *_ in SIGNALS:
    outs = [l['heading'] for l in links if l['from'] == sid] + [b['side'] for b in boundary if b['signal'] == sid and b['dir'] == 'exit']
    if len(outs) != len(set(outs)):
        sys.exit(f'{sid}: two outgoing legs snap to the same side: {outs}')

# ---- counts ----
rows = json.load(open(os.path.join(DATA, 'kendall_tmc_2026-10-13_to_15_utc.json')))
bus_rows = json.load(open(os.path.join(DATA, 'kendall_bus_2026-10-13_to_15_utc.json')))
DAYS = 3
tot = defaultdict(float)
for r in rows:
    tot[r['timebin'][11:16]] += float(r['q'])
bins = sorted(tot)


def peak(lo, hi):
    cands = [b for b in bins if lo <= b <= hi and bins.index(b) + 3 < len(bins)]
    return max(cands, key=lambda b: sum(tot[x] for x in bins[bins.index(b):bins.index(b) + 4]))


def utc_hm(local_h, local_m=0):
    return f'{(local_h + UTC_OFFSET) % 24:02d}:{local_m:02d}'


PERIODS = {
    'AM': peak(utc_hm(6, 30), utc_hm(9, 30)),
    'MIDDAY': utc_hm(12, 0),
    'PM': peak(utc_hm(15, 30), utc_hm(18, 30)),
}
sensor_of = {s[0]: s[4] for s in SIGNALS if s[4]}
SIDE_FROM_MIO = {'N': 'N', 'E': 'E', 'S': 'S', 'W': 'W'}
travel_into = {'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E'}  # entering from side X means heading travel_into[X]
LEFT_OF = {'N': 'W', 'W': 'S', 'S': 'E', 'E': 'N'}
RIGHT_OF = {'N': 'E', 'E': 'S', 'S': 'W', 'W': 'N'}


def turn(entry_side, exit_side):
    h = travel_into[entry_side]
    if exit_side == entry_side:
        return 'U'
    if exit_side == h:
        return 'T'
    if exit_side == LEFT_OF[h]:
        return 'L'
    if exit_side == RIGHT_OF[h]:
        return 'R'
    return '?'


def tmc_for(src, start):
    i = bins.index(start)
    hb = set(bins[i:i + 4])
    out = defaultdict(lambda: defaultdict(float))  # sid -> (entrance, exit) -> veh/h
    for r in src:
        if r['timebin'][11:16] in hb:
            for sid, name in sensor_of.items():
                if r['intersection'] == name:
                    out[sid][(r['entrance'], r['exit'])] += float(r['q']) / DAYS
    return out


notes = []
periods = {}
for pid, start in PERIODS.items():
    t_all = tmc_for(rows, start)
    t_bus = tmc_for(bus_rows, start)
    lh = (int(start[:2]) - UTC_OFFSET) % 24
    label = f"{lh:02d}:{start[3:]}–{(lh + 1) % 24:02d}:{start[3:]} EDT, avg of Tue–Thu 13–15 Oct 2026"
    turns, bus_turns, entries, bus_entries, observed = {}, {}, {}, {}, {}
    for sid, mv in t_all.items():
        by_entr = defaultdict(lambda: defaultdict(float))
        for (en, ex), q in mv.items():
            if en not in SIDE_FROM_MIO or ex not in SIDE_FROM_MIO:
                notes.append(f'{pid} {sid}: skipped non-cardinal leg {en}->{ex} ({q:.0f} veh/h)')
                continue
            tr = turn(en, ex)
            if tr in ('U', '?'):
                if q >= 1:
                    notes.append(f'{pid} {sid}: dropped {tr}-turn {en}->{ex} ({q:.0f} veh/h)')
                continue
            by_entr[en][tr] += q
        for en, shares in by_entr.items():
            observed[f'{sid}:{en}'] = round(sum(shares.values()), 1)
            turns[f'{sid}:{en}'] = {k: round(v, 2) for k, v in shares.items()}
    for sid, mv in t_bus.items():
        by_entr = defaultdict(lambda: defaultdict(float))
        for (en, ex), q in mv.items():
            if en in SIDE_FROM_MIO and ex in SIDE_FROM_MIO and turn(en, ex) in 'LTR':
                by_entr[en][turn(en, ex)] += q
        for en, shares in by_entr.items():
            bus_turns[f'{sid}:{en}'] = {k: round(v, 2) for k, v in shares.items()}
    for b in boundary:
        if b['dir'] != 'entry':
            continue
        key = f"{b['signal']}:{b['side']}"
        if key in observed:
            entries[key] = {'vph': observed[key], 'source': 'measured'}
            bq = sum(bus_turns.get(key, {}).values())
            if bq > 0:
                bus_entries[key] = round(bq, 2)
        else:
            # Unsensored boundary approach: modeled by street class.
            v = 250 if b['street'] in ('Cambridge Street', 'Binney Street') else 120
            entries[key] = {'vph': v, 'source': 'modeled'}
    # Flow balance at unsensored signals that sit between two sensors on the same street:
    # through share ≈ (measured arrivals at the downstream sensor) / (measured departures from the upstream sensor).
    exits = defaultdict(float)  # (sid, exit side) -> veh/h leaving that sensor on that side
    for sid, mv in t_all.items():
        for (en, ex), q in mv.items():
            if en in SIDE_FROM_MIO and ex in SIDE_FROM_MIO and turn(en, ex) in 'LTR':
                exits[(sid, ex)] += q
    estimated = {}
    opp = {'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E'}
    for u, up, down, heading in FLOW_BALANCE:
        dep = exits.get((up, heading), 0)  # leaving `up` on the side facing u
        arr = observed.get(f'{down}:{opp[heading]}', 0)  # entering `down` from the side facing u
        if dep < 20 or arr <= 0:
            continue
        ratio = arr / dep
        through = max(0.1, min(1.0, ratio))
        rest = 1 - through
        key = f'{u}:{opp[heading]}'  # traffic travelling `heading` enters u from the opposite side
        turns[key] = {'T': round(through, 3), 'L': round(rest / 2, 3), 'R': round(rest / 2, 3)}
        estimated[key] = {'up': up, 'down': down, 'departures': round(dep, 1), 'arrivals': round(arr, 1), 'ratio': round(ratio, 2)}
        if ratio > 1.05:
            notes.append(f'{pid} {u}: {ratio:.2f}x more traffic arrives at {down} than leaves {up}; the extra joins from side streets, so through share is capped at 100%')
    periods[pid] = {'label': label, 'utcStart': start, 'entries': entries, 'busEntries': bus_entries,
                    'turns': turns, 'busTurns': bus_turns, 'observed': observed, 'estimatedTurns': estimated}

# ---- check every measured leg exists in the model ----
for pid, p in periods.items():
    for key, shares in p['turns'].items():
        sid, en = key.split(':')
        has_in = any(l['to'] == sid and travel_into[en] == l['heading'] for l in links) or any(b['signal'] == sid and b['side'] == en and b['dir'] == 'entry' for b in boundary)
        if not has_in:
            notes.append(f'{pid} {sid}: measured approach from {en} ({sum(shares.values()):.0f} veh/h) has no entry in the OSM network')

out = {
    'generatedBy': 'research/scripts/build_kendall.py',
    'gridTilt': GRID_TILT,
    'signals': [{'id': s[0], 'name': s[3], 'streets': [s[1], s[2]], 'sensor': s[4],
                 'x': round(xy(*centre[s[0]])[0], 1), 'y': round(xy(*centre[s[0]])[1], 1),
                 'lat': round(centre[s[0]][0], 6), 'lon': round(centre[s[0]][1], 6)} for s in SIGNALS],
    'links': links,
    'boundary': boundary,
    'boundaryLength': BOUNDARY_LEN,
    'periods': periods,
    'notes': notes,
}
json.dump(out, open(out_path, 'w'), indent=1)
print(f'{len(links)} internal links, {len(boundary)} boundary legs')
for l in links:
    print(f"  {l['from']}->{l['to']} {l['heading']} {l['street']:18s} {l['pathLength']:6.1f} m  lanes {l['lanes']}  {l['vf']:.1f} m/s")
for b in boundary:
    print(f"  {b['signal']} {b['side']} {b['dir']:5s} {b['street']}  lanes {b['lanes']}")
for pid, p in periods.items():
    print(pid, p['label'], 'entries', {k: v['vph'] for k, v in p['entries'].items()})
print('\n'.join(notes))
