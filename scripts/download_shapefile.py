#!/usr/bin/env python3
"""
Downloads the official Provincial Electoral District boundaries from the
BC Geographic Data Warehouse (referenced by Elections BC:
https://elections.bc.ca/resources/maps/gis-spatial-data/
and DataBC: https://catalogue.data.gov.bc.ca/dataset/1cba4b16-263f-4d42-8d84-f5fecaa03d1a)
and outputs an optimized GeoJSON for high-performance web mapping.
"""

import os
import sys
import json
import urllib.request
from shapely.geometry import shape, mapping

WFS_URL = (
    "https://openmaps.gov.bc.ca/geo/pub/WHSE_ADMIN_BOUNDARIES.EBC_ELECTORAL_DISTS_BS11_SVW/ows?"
    "service=WFS&version=2.0.0&request=GetFeature&"
    "typeName=WHSE_ADMIN_BOUNDARIES.EBC_ELECTORAL_DISTS_BS11_SVW&"
    "outputFormat=application/json&SRSNAME=EPSG:4326"
)

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUTPUT_PATH = os.path.join(OUTPUT_DIR, "bc_districts.geojson")

def round_coords(obj, digits=4):
    """Rounds coordinates to optimize file size without visual quality loss."""
    if isinstance(obj, (float, int)):
        return round(obj, digits)
    if isinstance(obj, (list, tuple)):
        return [round_coords(x, digits) for x in obj]
    if isinstance(obj, dict):
        return {k: round_coords(v, digits) for k, v in obj.items()}
    return obj

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Fetching official electoral boundaries from OpenMaps WFS...")
    
    req = urllib.request.Request(WFS_URL, headers={"User-Agent": "BCElectionTracker/1.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw_data = json.loads(resp.read().decode("utf-8"))

    features = raw_data.get("features", [])
    print(f"Downloaded {len(features)} electoral district features.")
    
    if len(features) != 93:
        print(f"Warning: Expected 93 electoral districts, got {len(features)}")

    processed_features = []
    for f in features:
        props = f.get("properties", {})
        ed_name = props.get("ED_NAME", "").strip()
        ed_abbr = props.get("ED_ABBREVIATION", "").strip()
        ed_id = props.get("ELECTORAL_DISTRICT_ID")

        # Simplify geometry slightly (preserve topology) to keep web load snappy
        geom = shape(f["geometry"])
        simplified = geom.simplify(0.0008, preserve_topology=True)
        geom_dict = round_coords(mapping(simplified), 4)

        feature = {
            "type": "Feature",
            "properties": {
                "id": ed_id,
                "name": ed_name,
                "code": ed_abbr
            },
            "geometry": geom_dict
        }
        processed_features.append(feature)

    geojson_out = {
        "type": "FeatureCollection",
        "features": processed_features
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as out_f:
        json.dump(geojson_out, out_f, separators=(",", ":"))

    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"Successfully generated {OUTPUT_PATH} ({size_kb:.1f} KB, {len(processed_features)} districts).")

if __name__ == "__main__":
    main()
