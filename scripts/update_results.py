#!/usr/bin/env python3
"""
Elections BC Live Scraper & Updater
Scrapes real-time election night reporting directly from:
https://results.elections.bc.ca/
and its dynamic Results_..._Candidate.html breakdown.
Uses the 2024 General Election standings (on the exact same 93-district map) as the baseline for flips and net seat changes.
"""

import os
import sys
import json
import re
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from bs4 import BeautifulSoup

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "results.json")
GEOJSON_PATH = os.path.join(DATA_DIR, "bc_districts.geojson")
BASELINE_2024_PATH = os.path.join(DATA_DIR, "baseline_2024.json")

EBC_RESULTS_URL = "https://results.elections.bc.ca/"

PARTY_INFO = {
    "BC NDP": {
        "name": "BC New Democratic Party",
        "short": "NDP",
        "leader": "David Eby",
        "color": "#f58220",
        "secondary_color": "#ffb066",
        "seats_2024": 47
    },
    "BC Conservative": {
        "name": "Conservative Party of BC",
        "short": "CON",
        "leader": "John Rustad",
        "color": "#0c499c",
        "secondary_color": "#4d82cb",
        "seats_2024": 44
    },
    "BC Green": {
        "name": "BC Green Party",
        "short": "GRN",
        "leader": "Sonia Furstenau",
        "color": "#2e8b57",
        "secondary_color": "#66bb6a",
        "seats_2024": 2
    },
    "Independent": {
        "name": "Independent / Other",
        "short": "IND",
        "leader": "Various",
        "color": "#78909c",
        "secondary_color": "#b0bec5",
        "seats_2024": 0
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

def fetch_html(url, timeout=20):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ElectionsTracker/1.0"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")

def normalize_party(p_str):
    p = p_str.strip()
    if any(k in p for k in ["NDP", "New Democratic"]):
        return "BC NDP"
    if any(k in p for k in ["Conservative", "CPBC", "CP"]):
        return "BC Conservative"
    if any(k in p for k in ["Green", "GP"]):
        return "BC Green"
    if any(k in p for k in ["Lib", "Liberal", "United"]):
        return "BC Liberal"
    return "Independent"

def load_district_geo_mapping():
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

def load_2024_baseline():
    if os.path.exists(BASELINE_2024_PATH):
        try:
            with open(BASELINE_2024_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: could not read {BASELINE_2024_PATH}: {e}")
    return {}

def scrape_elections_bc():
    print(f"Fetching official live reporting from {EBC_RESULTS_URL}...")
    home_html = fetch_html(EBC_RESULTS_URL)
    home_soup = BeautifulSoup(home_html, "html.parser")

    # 1. Discover Candidate Page Link
    cand_url = None
    for a in home_soup.find_all("a", href=True):
        if "Candidate" in a["href"]:
            cand_url = urllib.parse.urljoin(EBC_RESULTS_URL, a["href"])
            break

    candidates_by_district = {}
    if cand_url:
        print(f"Fetching candidate details from {cand_url}...")
        try:
            cand_html = fetch_html(cand_url)
            cand_soup = BeautifulSoup(cand_html, "html.parser")
            cand_table = cand_soup.find("table", id="tblReport")
            if cand_table:
                cur_dist = None
                for r in cand_table.find_all("tr")[1:]:
                    cells = [c.get_text(strip=True) for c in r.find_all(["th", "td"])]
                    if len(cells) < 5:
                        continue
                    if cells[0]:
                        cur_dist = cells[0].strip().lower()
                        candidates_by_district[cur_dist] = []

                    name = cells[1].strip()
                    if name in ["Total Valid Votes", "Rejected Ballots*", "Total Considered Votes", ""]:
                        continue

                    affil = cells[2].strip()
                    votes = clean_num(cells[3])
                    pct = clean_num(cells[4])

                    if cur_dist:
                        candidates_by_district[cur_dist].append({
                            "name": name,
                            "party": normalize_party(affil),
                            "raw_affiliation": affil,
                            "votes": votes,
                            "pct": pct
                        })
        except Exception as e:
            print(f"Warning: could not parse candidate page ({e})")

    # 2. Parse Main District Results Table (tblReport)
    dist_table = home_soup.find("table", id="tblReport")
    if not dist_table:
        raise ValueError("Could not find table id='tblReport' on results.elections.bc.ca")

    geo_map = load_district_geo_mapping()
    baseline_2024 = load_2024_baseline()

    ridings = []
    total_valid_votes = 0
    total_rejected = 0
    total_boxes_reported = 0
    total_boxes_count = 0

    party_votes = {"BC NDP": 0, "BC Conservative": 0, "BC Green": 0, "Independent": 0}
    party_seats = {"BC NDP": 0, "BC Conservative": 0, "BC Green": 0, "Independent": 0}

    for row in dist_table.find_all("tr")[1:]:
        cells = [c.get_text(strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) < 10:
            continue

        raw_name = cells[0].strip()
        norm_key = raw_name.lower()

        # Name and code resolution
        official_name = raw_name
        code = ""
        if norm_key in geo_map:
            official_name = geo_map[norm_key]["name"]
            code = geo_map[norm_key]["code"]

        # Parse votes
        grn_votes = clean_num(cells[1])
        ndp_votes = clean_num(cells[2])
        con_votes = clean_num(cells[3])
        oth_votes = clean_num(cells[4])
        tot_valid = clean_num(cells[5])
        rejected = clean_num(cells[6])
        adv_boxes = cells[8]
        fin_boxes = cells[9]

        total_valid_votes += tot_valid
        total_rejected += rejected

        # Parse ballot boxes progress
        boxes_rep = 0
        boxes_tot = 0
        for b_text in [adv_boxes, fin_boxes]:
            m = re.search(r"(\d+)\s+of\s+(\d+)", b_text)
            if m:
                boxes_rep += int(m.group(1))
                boxes_tot += int(m.group(2))

        total_boxes_reported += boxes_rep
        total_boxes_count += boxes_tot

        party_votes["BC NDP"] += ndp_votes
        party_votes["BC Conservative"] += con_votes
        party_votes["BC Green"] += grn_votes
        party_votes["Independent"] += oth_votes

        # Determine Candidates
        cands = candidates_by_district.get(norm_key, [])
        if not cands:
            if ndp_votes > 0:
                cands.append({"name": "BC NDP Candidate", "party": "BC NDP", "raw_affiliation": "BC NDP", "votes": ndp_votes, "pct": round(ndp_votes/tot_valid*100, 2) if tot_valid > 0 else 0})
            if con_votes > 0:
                cands.append({"name": "BC Conservative Candidate", "party": "BC Conservative", "raw_affiliation": "Conservative Party", "votes": con_votes, "pct": round(con_votes/tot_valid*100, 2) if tot_valid > 0 else 0})
            if grn_votes > 0:
                cands.append({"name": "BC Green Candidate", "party": "BC Green", "raw_affiliation": "BC Green Party", "votes": grn_votes, "pct": round(grn_votes/tot_valid*100, 2) if tot_valid > 0 else 0})
            if oth_votes > 0:
                cands.append({"name": "Independent / Other", "party": "Independent", "raw_affiliation": "Other", "votes": oth_votes, "pct": round(oth_votes/tot_valid*100, 2) if tot_valid > 0 else 0})

        # Sort candidates descending by votes
        cands.sort(key=lambda c: c["votes"], reverse=True)

        if cands and cands[0]["votes"] > 0:
            winner_candidate = cands[0]["name"]
            winner_party = cands[0]["party"]
            winner_votes = cands[0]["votes"]
            winner_share = round((winner_votes / tot_valid * 100), 2) if tot_valid > 0 else 0
            runner_up = cands[1] if len(cands) > 1 else None
            margin_votes = winner_votes - (runner_up["votes"] if runner_up else 0)
            margin_pct = round((margin_votes / tot_valid * 100), 2) if tot_valid > 0 else 0
            is_declared = (boxes_rep >= boxes_tot and boxes_tot > 0)
        else:
            winner_candidate = "Awaiting Counts"
            winner_party = "Independent"
            winner_votes = 0
            winner_share = 0
            runner_up = None
            margin_votes = 0
            margin_pct = 0
            is_declared = False

        if winner_party in party_seats:
            party_seats[winner_party] += 1

        is_battleground = (margin_pct <= 3.5 and winner_votes > 0)

        # Baseline 2024 comparison on the exact same 93 maps
        b_info = baseline_2024.get(norm_key, {})
        party_2024 = b_info.get("party_2024", "Unknown")

        if winner_votes > 0 and party_2024 != "Unknown" and winner_party != party_2024:
            is_flip = True
            flip_description = f"Flipped from {party_2024} to {winner_party}"
            flip_badge = f"{winner_party} Gain from {party_2024}"
        elif winner_votes > 0 and party_2024 != "Unknown" and winner_party == party_2024:
            is_flip = False
            flip_description = f"{winner_party} Hold"
            flip_badge = f"{winner_party} Hold"
        else:
            is_flip = False
            flip_description = "Pending Counts"
            flip_badge = "Pending"

        # Mark elected flag
        for c in cands:
            c["elected"] = (c["name"] == winner_candidate and winner_votes > 0)

        poll_progress_pct = round((boxes_rep / boxes_tot * 100), 1) if boxes_tot > 0 else 0

        ridings.append({
            "name": official_name,
            "code": code,
            "status": "Declared" if is_declared else f"{boxes_rep}/{boxes_tot} Polls",
            "boxes_reported": boxes_rep,
            "boxes_total": boxes_tot,
            "poll_progress_pct": poll_progress_pct,
            "winner_party": winner_party,
            "winning_candidate": winner_candidate,
            "winner_votes": winner_votes,
            "winner_share": winner_share,
            "margin_votes": margin_votes,
            "margin_pct": margin_pct,
            "is_battleground": is_battleground,
            "is_flip": is_flip,
            "flip_description": flip_description,
            "flip_badge": flip_badge,
            "party_2024": party_2024,
            "prev_party": party_2024,
            "turnout_pct": round((tot_valid / 38000 * 100), 1),
            "total_votes": tot_valid,
            "rejected_ballots": rejected,
            "runner_up_party": runner_up["party"] if runner_up else None,
            "runner_up_candidate": runner_up["name"] if runner_up else None,
            "runner_up_votes": runner_up["votes"] if runner_up else 0,
            "candidates": cands
        })

    ridings.sort(key=lambda r: r["name"])

    # Party Summaries with 2024 Comparison Net Change
    parties_summary = {}
    for p_key, meta in PARTY_INFO.items():
        votes = party_votes.get(p_key, 0)
        seats = party_seats.get(p_key, 0)
        baseline_seats = meta.get("seats_2024", 0)
        net_change = seats - baseline_seats
        pct = round((votes / total_valid_votes * 100), 2) if total_valid_votes > 0 else 0

        sign = "+" if net_change > 0 else ""
        net_str = f"{sign}{net_change}" if net_change != 0 else "0"

        parties_summary[p_key] = {
            **meta,
            "seats": seats,
            "seats_2024": baseline_seats,
            "net_seat_change": net_change,
            "net_seat_change_str": net_str,
            "votes": votes,
            "vote_share_pct": pct,
            "majority": seats >= 47
        }

    overall_poll_progress = round((total_boxes_reported / total_boxes_count * 100), 1) if total_boxes_count > 0 else 0
    flips_list = [r for r in ridings if r["is_flip"]]

    return {
        "metadata": {
            "title": "British Columbia General Election - Live Night Reporting",
            "source": "Elections BC (results.elections.bc.ca)",
            "source_url": EBC_RESULTS_URL,
            "baseline_election": "2024 General Election (identical 93 boundaries)",
            "legislature": "43rd Parliament of British Columbia",
            "total_seats": 93,
            "majority_threshold": 47,
            "ridings_reporting": len(ridings),
            "total_ridings": 93,
            "total_votes_cast": total_valid_votes,
            "total_boxes_reported": total_boxes_reported,
            "total_boxes_count": total_boxes_count,
            "overall_poll_progress": overall_poll_progress,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "status": f"Live Preliminary Count ({overall_poll_progress}% of ballot boxes reported)"
        },
        "parties": parties_summary,
        "summary": {
            "total_battlegrounds": len([r for r in ridings if r["is_battleground"]]),
            "total_flips": len(flips_list),
            "leading_party": max(parties_summary.items(), key=lambda x: x[1]["seats"])[0]
        },
        "ridings": ridings
    }

def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    try:
        data = scrape_elections_bc()
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"Successfully scraped live results from Elections BC into {OUTPUT_PATH}")
        print(f"Poll progress: {data['metadata']['overall_poll_progress']}% ({data['metadata']['total_boxes_reported']}/{data['metadata']['total_boxes_count']} ballot boxes)")
        print(f"Standings vs 2024 Baseline:")
        for p, d in data['parties'].items():
            print(f"  {p}: {d['seats']} seats ({d['net_seat_change_str']} net change vs 2024 baseline {d['seats_2024']})")
        print(f"Total seat flips: {data['summary']['total_flips']}")
    except Exception as e:
        print(f"Error scraping live results: {e}", file=sys.stderr)
        if not os.path.exists(OUTPUT_PATH):
            sys.exit(1)

if __name__ == "__main__":
    main()
