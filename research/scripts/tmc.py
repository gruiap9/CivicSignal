import json, sys
from collections import defaultdict
rows = json.load(open(sys.argv[1]))
days = ['2026-10-13', '2026-10-14', '2026-10-15']
UTC_OFFSET = 4  # EDT
tot = defaultdict(float)
for r in rows: tot[r['timebin'][11:16]] += float(r['q'])
bins = sorted(tot)
cands = [b for b in bins if '19:00' <= b <= '23:00' and bins.index(b) + 3 < len(bins)]
best = max(cands, key=lambda b: sum(tot[x] for x in bins[bins.index(b):bins.index(b) + 4]))
hb = bins[bins.index(best):bins.index(best) + 4]
lh = int(best[:2]) - UTC_OFFSET
print(f'PM peak hour: {best}-{hb[-1]}+15 UTC  =  {lh:02d}:{best[3:]}–{lh+1:02d}:{best[3:]} EDT (avg of Tue–Thu 13–15 Oct 2026)\n')
LEFT = {'N': 'E', 'S': 'W', 'E': 'S', 'W': 'N'}  # entering from N (heading S): left turn exits E
RIGHT = {'N': 'W', 'S': 'E', 'E': 'N', 'W': 'S'}
OPP = {'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E'}
tmc = defaultdict(lambda: defaultdict(list))
for r in rows:
    if r['timebin'][11:16] in hb:
        tmc[r['intersection']][(r['entrance'], r['exit'], r['timebin'][:10])].append(float(r['q']))
out = {}
for inter in sorted(tmc):
    per = defaultdict(lambda: defaultdict(float))
    for (en, ex, day), qs in tmc[inter].items(): per[(en, ex)][day] += sum(qs)
    print(f'## {inter}')
    tot_i = 0; table = {}
    for (en, ex), byday in sorted(per.items()):
        vals = [byday.get(d, 0) for d in days]; avg = sum(vals) / 3; tot_i += avg
        mv = 'U' if en == ex else 'L' if LEFT.get(en) == ex else 'R' if RIGHT.get(en) == ex else 'T' if OPP.get(en) == ex else '?'
        table[f'{en}->{ex}'] = avg
        if avg >= 5: print(f'   from {en:2s} to {ex:2s} [{mv}] {avg:5.0f} veh/h   (days: {", ".join(f"{v:.0f}" for v in vals)})')
    print(f'   total {tot_i:.0f} veh/h\n'); out[inter] = table
json.dump({'peak_utc': best, 'tmc': out}, open(sys.argv[2], 'w'), indent=1)
