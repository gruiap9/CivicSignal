#!/usr/bin/env bash
# Downloads the OpenStreetMap extracts used by locate.py, corridors.py and mapsvg.py.
# Usage: scripts/fetch_osm.sh <out_dir>
set -euo pipefail
OUT=${1:-osm}
mkdir -p "$OUT"
BBOX='42.355,-71.098,42.374,-71.072'
UA='CivicSignal-hackathon-research'
ROADS="[out:json][timeout:60];(way[\"highway\"~\"^(primary|secondary|tertiary|residential|unclassified|primary_link|secondary_link|tertiary_link|trunk)$\"]($BBOX););out body;>;out skel qt;"
CONTROL="[out:json][timeout:60];(node[\"highway\"~\"traffic_signals|stop|give_way|crossing\"]($BBOX);node[\"crossing\"]($BBOX);node[\"traffic_signals\"]($BBOX););out body;"
curl -s -A "$UA" --data-urlencode "data=$ROADS" https://overpass-api.de/api/interpreter -o "$OUT/kendall.json"
sleep 2
curl -s -A "$UA" --data-urlencode "data=$CONTROL" https://overpass-api.de/api/interpreter -o "$OUT/control.json"
echo "Saved $OUT/kendall.json and $OUT/control.json"
