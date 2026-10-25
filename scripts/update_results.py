#!/usr/bin/env python3
"""
BC Election Results Scraper & Updater
Collects election results across all 93 British Columbia electoral districts.
Designed to run locally or automated via GitHub Actions on a schedule throughout election night.
"""

import os
import sys
import json
import re
import urllib.request
from datetime import datetime, timezone
from bs4 import BeautifulSoup

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "results.json")
GEOJSON_PATH = os.path.join(DATA_DIR, "bc_districts.geojson")

PARTY_INFO = {
    "BC NDP": {
        "name": "BC New Democratic Party",
        "short": "NDP",
        "leader": "David Eby",
        "color": "#f58220",
        "secondary_color": "#ffb066"
    },
    "BC Conservative": {
        "name": "Conservative Party of BC",
        "short": "CON",
        "leader": "John Rustad",
        "color": "#0c499c",
        "secondary_color": "#4d82cb"
    },
    "BC Green": {
        "name": "BC Green Party",
        "short": "GRN",
        "leader": "Sonia Furstenau",
        "color": "#2e8b57",
        "secondary_color": "#66bb6a"
    },
    "Independent": {
        "name": "Independent / Other",
        "short": "IND",
        "leader": "Various",
        "color": "#78909c",
        "secondary_color": "#b0bec5"
    }
}

def clean_num(val):
    if not val:
        return 0
    val_str = str(val).replace(",", "").replace("+", "").replace("−", "-").replace("–", "0").replace("%", "").strip()
    try:
        return int(val_str)
    except ValueError:
        try:
            return float(val_str)
        except ValueError:
            return 0

def fetch_json(url, headers=None, timeout=20):
    default_headers = {"User-Agent": "BCElectionTracker/1.0 (https://github.com/)"}
    if headers:
        default_headers.update(headers)
    req = urllib.request.Request(url, headers=default_headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def normalize_party(p_str):
    p = p_str.strip()
    if p in ["NDP", "BC NDP", "New Democratic Party"]:
        return "BC NDP"
    if p in ["Con", "CPBC", "Conservative", "BC Conservative"]:
        return "BC Conservative"
    if p in ["Green", "Grn", "BC Green", "Green Party"]:
        return "BC Green"
    if p in ["Lib", "BC United", "Liberal", "BC Liberal"]:
        return "BC Liberal"
    return "Independent"

def load_district_geo_mapping():
    """Load district names and codes from GeoJSON to ensure 100% naming match."""
    mapping = {}
    if os.path.exists(GEOJSON_PATH):
        try:
            with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
                geo = json.load(f)
                for feat in geo.get("features", []):
                    props = feat.get("properties", {})
                    name = props.get("name")
                    code = props.get("code")
                    if name:
                        mapping[name.lower()] = {"name": name, "code": code}
        except Exception as e:
            print(f"Warning: could not read {GEOJSON_PATH}: {e}")
    return mapping

def scrape_candidates():
    """Fetches candidate names for each riding."""
    url = "https://en.wikipedia.org/w/api.php?action=parse&page=Results_of_the_2024_British_Columbia_general_election_by_riding&prop=text&format=json"
    print("Fetching riding candidates...")
    try:
        data = fetch_json(url)
        html = data["parse"]["text"]["*"]
        soup = BeautifulSoup(html, "html.parser")
        tables = soup.find_all("table", class_="wikitable")

        riding_candidates = {}
        for t in tables:
            rows = t.find_all("tr")
            if len(rows) < 3:
                continue
            for row in rows[2:]:
                cells = [c.get_text(strip=True) for c in row.find_all(["th", "td"])]
                if len(cells) < 7:
                    continue
                rd_name = cells[0].split("[")[0].strip()
                ndp_cand = cells[2] if len(cells) > 2 else ""
                grn_cand = cells[4] if len(cells) > 4 else ""
                con_cand = cells[6] if len(cells) > 6 else ""
                oth_cand = cells[8] if len(cells) > 8 else ""

                # clean candidate names
                def clean_cand(c):
                    c = re.sub(r"\[.*?\]", "", c)
                    return c.strip()

                riding_candidates[rd_name.lower()] = {
                    "BC NDP": clean_cand(ndp_cand),
                    "BC Green": clean_cand(grn_cand),
                    "BC Conservative": clean_cand(con_cand),
                    "Independent": clean_cand(oth_cand)
                }
        print(f"Loaded candidates for {len(riding_candidates)} ridings.")
        return riding_candidates
    except Exception as e:
        print(f"Error scraping candidates: {e}")
        return {}

def scrape_results():
    """Scrapes election synopsis results across all 93 ridings."""
    url = "https://en.wikipedia.org/w/api.php?action=parse&page=2024_British_Columbia_general_election&section=22&prop=text&format=json"
    print("Fetching riding-by-riding election results...")
    data = fetch_json(url)
    html = data["parse"]["text"]["*"]
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    rows = table.find_all("tr")

    geo_map = load_district_geo_mapping()
    candidate_map = scrape_candidates()

    ridings = []
    total_valid_votes = 0
    party_votes = {"BC NDP": 0, "BC Conservative": 0, "BC Green": 0, "Independent": 0}
    party_seats = {"BC NDP": 0, "BC Conservative": 0, "BC Green": 0, "Independent": 0}

    for row in rows[4:]:
        tds = row.find_all(["td", "th"])
        cells = [c.get_text(strip=True) for c in tds]
        if not cells or len(cells) < 8:
            continue

        raw_name = cells[0].split("[")[0].strip()
        norm_key = raw_name.lower()

        # Match with official Geo name if exists
        official_name = raw_name
        code = ""
        if norm_key in geo_map:
            official_name = geo_map[norm_key]["name"]
            code = geo_map[norm_key]["code"]

        is_new = (cells[1] == "New")
        if is_new:
            prev_party = "New Riding"
            winner_raw = cells[3]
            winner_votes = clean_num(cells[4])
            winner_share_str = cells[5]
            margin_votes = abs(clean_num(cells[6]))
            margin_pct_str = cells[7]
        else:
            prev_party = cells[2]
            winner_raw = cells[4]
            winner_votes = clean_num(cells[5])
            winner_share_str = cells[6]
            margin_votes = abs(clean_num(cells[7]))
            margin_pct_str = cells[8]

        winner_party = normalize_party(winner_raw)

        # Parse vote totals from tail cells
        ndp_votes = clean_num(cells[-6])
        con_votes = clean_num(cells[-5])
        grn_votes = clean_num(cells[-4])
        oth_votes = clean_num(cells[-3])
        turnout_str = cells[-7]
        tot_votes = clean_num(cells[-1])

        if tot_votes == 0:
            tot_votes = ndp_votes + con_votes + grn_votes + oth_votes

        total_valid_votes += tot_votes
        party_votes["BC NDP"] += ndp_votes
        party_votes["BC Conservative"] += con_votes
        party_votes["BC Green"] += grn_votes
        party_votes["Independent"] += oth_votes

        party_seats[winner_party] = party_seats.get(winner_party, 0) + 1

        margin_pct = clean_num(margin_pct_str)
        is_battleground = (margin_pct <= 3.5)

        # Flip determination
        prev_norm = normalize_party(prev_party)
        if prev_party == "New Riding":
            is_flip = False
            flip_text = "New District"
        elif prev_norm != winner_party:
            is_flip = True
            flip_text = f"Flipped from {prev_norm} to {winner_party}"
        else:
            is_flip = False
            flip_text = f"{winner_party} Hold"

        # Candidate breakdown
        cands_meta = candidate_map.get(norm_key, {})
        candidates = []
        if ndp_votes > 0 or cands_meta.get("BC NDP"):
            candidates.append({
                "name": cands_meta.get("BC NDP") or "NDP Candidate",
                "party": "BC NDP",
                "votes": ndp_votes,
                "pct": round((ndp_votes / tot_votes * 100), 2) if tot_votes > 0 else 0,
                "elected": (winner_party == "BC NDP")
            })
        if con_votes > 0 or cands_meta.get("BC Conservative"):
            candidates.append({
                "name": cands_meta.get("BC Conservative") or "Conservative Candidate",
                "party": "BC Conservative",
                "votes": con_votes,
                "pct": round((con_votes / tot_votes * 100), 2) if tot_votes > 0 else 0,
                "elected": (winner_party == "BC Conservative")
            })
        if grn_votes > 0 or cands_meta.get("BC Green"):
            candidates.append({
                "name": cands_meta.get("BC Green") or "Green Candidate",
                "party": "BC Green",
                "votes": grn_votes,
                "pct": round((grn_votes / tot_votes * 100), 2) if tot_votes > 0 else 0,
                "elected": (winner_party == "BC Green")
            })
        if oth_votes > 0 or cands_meta.get("Independent"):
            candidates.append({
                "name": cands_meta.get("Independent") or "Independent / Other",
                "party": "Independent",
                "votes": oth_votes,
                "pct": round((oth_votes / tot_votes * 100), 2) if tot_votes > 0 else 0,
                "elected": (winner_party == "Independent")
            })

        # Sort candidates by votes desc
        candidates.sort(key=lambda c: c["votes"], reverse=True)

        # Winning candidate name
        winning_candidate = candidates[0]["name"] if candidates else "Elected Candidate"
        runner_up = candidates[1] if len(candidates) > 1 else None

        ridings.append({
            "name": official_name,
            "code": code,
            "status": "Declared",
            "winner_party": winner_party,
            "winning_candidate": winning_candidate,
            "winner_votes": winner_votes,
            "winner_share": clean_num(winner_share_str),
            "margin_votes": margin_votes,
            "margin_pct": margin_pct,
            "is_battleground": is_battleground,
            "is_flip": is_flip,
            "flip_description": flip_text,
            "prev_party": prev_party,
            "turnout_pct": clean_num(turnout_str),
            "total_votes": tot_votes,
            "runner_up_party": runner_up["party"] if runner_up else None,
            "runner_up_candidate": runner_up["name"] if runner_up else None,
            "runner_up_votes": runner_up["votes"] if runner_up else 0,
            "candidates": candidates
        })

    # Sort ridings alphabetically
    ridings.sort(key=lambda r: r["name"])

    # Popular vote summary
    parties_summary = {}
    for p_key, meta in PARTY_INFO.items():
        votes = party_votes.get(p_key, 0)
        seats = party_seats.get(p_key, 0)
        pct = round((votes / total_valid_votes * 100), 2) if total_valid_votes > 0 else 0
        parties_summary[p_key] = {
            **meta,
            "seats": seats,
            "votes": votes,
            "vote_share_pct": pct,
            "majority": seats >= 47
        }

    flips_list = [r for r in ridings if r["is_flip"]]
    battlegrounds_list = [r for r in ridings if r["is_battleground"]]

    out_data = {
        "metadata": {
            "title": "2024 British Columbia General Election Results",
            "legislature": "43rd Parliament of British Columbia",
            "total_seats": 93,
            "majority_threshold": 47,
            "ridings_reporting": len(ridings),
            "total_ridings": 93,
            "total_votes_cast": total_valid_votes,
            "provincial_turnout_pct": 58.45,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "status": "Final Official Count"
        },
        "parties": parties_summary,
        "summary": {
            "total_battlegrounds": len(battlegrounds_list),
            "total_flips": len(flips_list),
            "leading_party": max(parties_summary.items(), key=lambda x: x[1]["seats"])[0]
        },
        "ridings": ridings
    }

    return out_data

def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    custom_url = os.environ.get("RESULTS_URL") or os.environ.get("RESULTS_FEED_URL")
    if custom_url:
        print(f"Custom results endpoint provided: {custom_url}")
        # If user provides a custom JSON endpoint, attempt fetching it
        try:
            custom_data = fetch_json(custom_url)
            with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
                json.dump(custom_data, f, indent=2)
            print(f"Saved custom feed results to {OUTPUT_PATH}")
            return
        except Exception as e:
            print(f"Custom endpoint failed ({e}), falling back to primary election scraper.")

    try:
        data = scrape_results()
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"Successfully generated {OUTPUT_PATH} ({len(data['ridings'])} ridings).")
        print(f"NDP: {data['parties']['BC NDP']['seats']} seats | CON: {data['parties']['BC Conservative']['seats']} seats | GRN: {data['parties']['BC Green']['seats']} seats")
    except Exception as e:
        print(f"Error generating results: {e}", file=sys.stderr)
        if os.path.exists(OUTPUT_PATH):
            print("Preserving existing results.json")
        else:
            sys.exit(1)

if __name__ == "__main__":
    main()
