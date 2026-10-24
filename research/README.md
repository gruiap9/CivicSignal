# Kendall / East Cambridge: is the sensor data usable for CivicSignal?

**Verdict: yes.** Eight City of Cambridge sensors in Kendall / East Cambridge sit on five connected streets and form a usable network. Their peak-hour flows agree with each other, and the data is current and public domain. Signal timing is **not** published.

Open `kendall-network.html` for the map.

## Sources (checked directly, 24 Oct 2026)

| Data | Source | License | Notes |
|---|---|---|---|
| Turning-movement counts, 15-min, by vehicle class | City of Cambridge, [Miovision Traffic Volume Data (All)](https://data.cambridgema.gov/Transportation/Miovision-Traffic-Volume-Data-All-/jwtp-n65u/about_data), dataset `jwtp-n65u` | ODC PDDL (public domain) | 21 intersections citywide, Feb 2020 to present, updated weekly |
| Street geometry, signal locations | OpenStreetMap via Overpass API | ODbL (© OpenStreetMap contributors) | Signals are mapped as `highway=traffic_signals` or as signalized crosswalks |
| Signal timing plans | not published | — | Must be requested from Cambridge Traffic, Parking & Transportation |

## Facts about the dataset that matter

- **Timestamps are UTC, not Boston time.** Volume bottoms out at 06:00–07:00 UTC (2–3 AM in Boston) and peaks at 12:00 UTC (8 AM) and 21:00 UTC (5 PM). Subtract 4 h in summer (EDT) and 5 h in winter (EST).
- **`entrance` is the leg a vehicle comes from; `exit` is the leg it leaves by.** Confirmed by matching flows between adjacent sensors (below).
- **Motor vehicles** = `Light` + `Bus` + `SingleUnitTruck` + `ArticulatedTruck` + `MotorizedVehicle`. `MotorizedVehicle` is a handful of unclassified vehicles, not a total. `Bicycle` is excluded. Buses are a separate class, so transit priority can use real bus volumes.
- **Diagonal legs exist** (`NW` at Binney / Galileo / Fulkerson), so the simulator needs non-4-way intersections there.
- **Coverage on 13–15 Oct 2026:** 96/96 fifteen-minute bins per day at every cluster sensor, except First / Thorndike (94, 96, 95).
- **The sensors count vehicles that got through.** In heavy congestion this undercounts the true demand.

## The network

Eight sensors, all signalized, on Binney, Third, First, Cambridge St and Broadway:

| Sensor (dataset name) | 5 PM peak, veh/h |
|---|---|
| Third Street and Cambridge Street | 1,349 |
| First Street and Binney Street | 1,185 |
| Third Street and Binney Street | 1,159 |
| Cambridge St at First Street and N. First Street | 1,100 |
| Binney Street and Fulkerson Street (with Galileo Galilei Way) | 1,044 |
| Galileo Galilei Way and Broadway | 997 |
| Broadway and Third Street | 897 |
| First Street and Thorndike Street (T-junction) | 648 |

**Signalized intersections between sensors that have no sensor of their own:**
- Binney & Sixth
- Binney & Second
- Third & Charles
- First & Charles / CambridgeSide Pl
- Cambridge & Second
- Cambridge & Sixth
- Broadway & Ames

Their volumes would have to be modeled from flow balance.

**Distances along each street** (from OSM, sensor to next signal):
- Binney: Galileo → Sixth 162 m → Third 305 m → Second 212 m → First 139 m
- Third St: Broadway → Binney 374 m → Charles 245 m → Cambridge 385 m
- First St: Binney → Charles 234 m → Thorndike 227 m → Cambridge 155 m

## Peak hour and consistency check

The PM peak hour is **16:45–17:45 EDT**, averaged over Tue–Thu 13–15 Oct 2026. Full turning-movement counts per sensor are in `data/pm_peak_tmc.json`; the three daily values per movement are mostly within ±15%.

Flow leaving one sensor vs. flow arriving at the next one along the street:

| Link | Leaving | Arriving | Signal(s) in between |
|---|---|---|---|
| First St NB, Thorndike → Cambridge | 404 | 414 | none |
| First St SB, Cambridge → Thorndike | 211 | 209 | none |
| Third St NB, Binney → Cambridge | 310 | 306 | Charles |
| Third St NB, Broadway → Binney | 228 | 250 | none |
| Third St SB, Binney → Broadway | 224 | 255 | none |
| Binney EB, Third → First | 311 | 295 | Second |
| Binney WB, First → Third | 331 | 236 | Second (~95 veh/h leave) |
| Cambridge WB, First → Third | 236 | 444 | Second (~200 veh/h join) |

Links with no signal between them match to within ±14%. The large gaps are all at Second St, which has no sensor.

## What this means for the rebuild

- **Usable:** real arrival rates per entry approach, real turning shares at 8 intersections, real bus volumes, and real day-to-day variation (for the seeds).
- **Still modeled:**
  - signal timing (Webster's method from these real counts, labeled as modeled);
  - the 7 unsensored signals;
  - lane counts (from OSM where tagged).
- **Simulator work needed:**
  - real geometry instead of a uniform grid;
  - intersections with 3 legs (T-junctions) and diagonal legs;
  - unequal block lengths.

## Reproduce

Run from this folder. The scripts are standalone Python 3, use only the standard library, and fetch from public APIs. In `scripts/`:

- `pull.py`: downloads the counts.
- `peak.py`: checks coverage and finds the peak hours.
- `tmc.py`: builds the peak-hour turning counts.
- `locate.py`: geocodes the sensors with OSM.
- `corridors.py`: finds the signals along each street.
- `mapsvg.py`: draws the map.

The OSM extract is not committed. Re-download it with `scripts/fetch_osm.sh osm`, then run `python3 scripts/locate.py osm/kendall.json data/sensors.json`.
