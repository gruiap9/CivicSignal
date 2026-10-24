import json, sys
from collections import defaultdict
rows = json.load(open(sys.argv[1]))
for r in rows: r['q'] = int(float(r['q']))
inters = sorted({r['intersection'] for r in rows})
days = ['2026-10-13', '2026-10-14', '2026-10-15']
# coverage
print('Coverage (distinct 15-min bins with data, of 96/day):')
for i in inters:
    print('  ', i[:48].ljust(48), [len({r['timebin'] for r in rows if r['intersection'] == i and r['timebin'].startswith(d)}) for d in days])
print('Legs seen:', sorted({r['entrance'] for r in rows} | {r['exit'] for r in rows}))
# cluster total by 15-min bin, averaged over the days
tot = defaultdict(int)
for r in rows: tot[r['timebin'][11:16]] += r['q']
bins = sorted(tot)
def hour(start):
    i = bins.index(start); return sum(tot[b] for b in bins[i:i + 4]) / len(days)
for label, lo, hi in [('AM', '06:00', '10:00'), ('PM', '15:00', '19:00')]:
    cands = [b for b in bins if lo <= b <= hi and bins.index(b) + 3 < len(bins)]
    best = max(cands, key=hour)
    print(f'{label} peak hour (cluster, 3-day avg): {best} start, {hour(best):.0f} veh/h through 8 sensors')
