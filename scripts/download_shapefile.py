#!/usr/bin/env python3
"""
Downloads the official Provincial Electoral District boundaries from the
BC Geographic Data Warehouse and clips them to the official BC terrestrial/coastline
landmass so that ocean waters (Strait of Georgia, Juan de Fuca Strait, etc.)
are not shaded, allowing Vancouver Island and the mainland to display with natural geography.
"""

import os
import sys
import json
import urllib.request
from shapely.geometry import shape, mapping, MultiPolygon
from shapely.ops import unary_union

WFS_URL = (
    "https://openmaps.gov.bc.ca/geo/pub/WHSE_ADMIN_BOUNDARIES.EBC_ELECTORAL_DISTS_BS11_SVW/ows?"
    "service=WFS&version=2.0.0&request=GetFeature&"
    "typeName=WHSE_ADMIN_BOUNDARIES.EBC_ELECTORAL_DISTS_BS11_SVW&"
    "outputFormat=application/json&SRSNAME=EPSG:4326"
)

BC_LAND_URL = "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/canada.geojson"

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
    print("Fetching BC terrestrial landmass/shoreline boundary...")
    req_land = urllib.request.Request(BC_LAND_URL, headers={"User-Agent": "BCElectionTracker/1.0"})
    with urllib.request.urlopen(req_land, timeout=30) as resp:
        canada_data = json.loads(resp.read().decode("utf-8"))

    bc_land_feature = next(f for f in canada_data["features"] if "columbia" in f["properties"]["name"].lower())
    bc_land_geom = shape(bc_land_feature["geometry"])
    if not bc_land_geom.is_valid:
        bc_land_geom = bc_land_geom.buffer(0)

    print("Fetching official electoral boundaries from OpenMaps WFS...")
    req_wfs = urllib.request.Request(WFS_URL, headers={"User-Agent": "BCElectionTracker/1.0"})
    with urllib.request.urlopen(req_wfs, timeout=90) as resp:
        raw_data = json.loads(resp.read().decode("utf-8"))

    features = raw_data.get("features", [])
    print(f"Downloaded {len(features)} electoral district features.")

    processed_features = []
    for f in features:
        props = f.get("properties", {})
        ed_name = props.get("ED_NAME", "").strip()
        ed_abbr = props.get("ED_ABBREVIATION", "").strip()
        ed_id = props.get("ELECTORAL_DISTRICT_ID")

        geom = shape(f["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)

        # Clip district to landmass so water is not shaded
        clipped = geom.intersection(bc_land_geom)

        # Extract only polygon geometries if a collection is returned
        if clipped.geom_type == "GeometryCollection":
            polys = [p for p in clipped.geoms if p.geom_type in ["Polygon", "MultiPolygon"]]
            clipped = unary_union(polys) if polys else geom
        elif clipped.is_empty:
            clipped = geom

        # Simplify slightly (preserve topology) to keep web load snappy
        simplified = clipped.simplify(0.0006, preserve_topology=True)
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
    print(f"Successfully generated shoreline-clipped {OUTPUT_PATH} ({size_kb:.1f} KB, {len(processed_features)} districts).")

if __name__ == "__main__":
    main()
