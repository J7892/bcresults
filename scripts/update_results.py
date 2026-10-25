#!/usr/bin/env python3
"""
Elections BC Live Scraper & Updater
Scrapes real-time election night reporting directly from:
https://results.elections.bc.ca/
and its dynamic Results_..._Candidate.html breakdown.
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

EBC_RESULTS_URL = "https://results.elections.bc.ca/"

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

# 2020 Historical Reference for Hold/Flip calculation
HISTORICAL_2020 = {
    "abbotsford-mission": "NDP",
    "abbotsford south": "Lib",
    "abbotsford west": "Lib",
    "boundary-similkameen": "NDP",
    "bulkley valley-stikine": "NDP",
    "burnaby centre": "New",
    "burnaby east": "NDP",
    "burnaby north": "NDP",
    "burnaby south-metrotown": "New",
    "burnaby-new westminster": "New",
    "cariboo-chilcotin": "Lib",
    "chilliwack-cultus lake": "NDP",
    "chilliwack north": "NDP",
    "columbia river-revelstoke": "Lib",
    "coquitlam-burke mountain": "NDP",
    "coquitlam-maillardville": "NDP",
    "courtenay-comox": "NDP",
    "cowichan valley": "Green",
    "delta north": "NDP",
    "delta south": "Lib",
    "esquimalt-colwood": "NDP",
    "fraser-nicola": "Lib",
    "kamloops centre": "Lib",
    "kamloops-north thompson": "Lib",
    "kelowna centre": "New",
    "kelowna-lake country-coldstream": "Lib",
    "kelowna-mission": "Lib",
    "kootenay central": "NDP",
    "kootenay-monashee": "NDP",
    "kootenay rockies": "Lib",
    "ladysmith-oceanside": "NDP",
    "langford-highlands": "NDP",
    "langley-abbotsford": "New",
    "langley walnut grove": "NDP",
    "langley willowbrook": "NDP",
    "maple ridge east": "NDP",
    "maple ridge-pitt meadows": "NDP",
    "mid island-pacific rim": "NDP",
    "nanaimo-gabriola island": "NDP",
    "nanaimo-ladoo": "NDP",
    "nechako lakes": "Lib",
    "nelson-creston": "NDP",
    "new westminster-coquitlam": "NDP",
    "north coast-haida gwaii": "NDP",
    "north island": "NDP",
    "north vancouver-lonsdale": "NDP",
    "north vancouver-seymour": "NDP",
    "oak bay-gordon head": "NDP",
    "parksville-qualicum": "NDP",
    "peace river north": "Lib",
    "peace river south": "Lib",
    "penticton-summerland": "Lib",
    "port coquitlam": "NDP",
    "port moody-burquitlam": "NDP",
    "prince george-mackenzie": "Lib",
    "prince george-north cariboo": "Lib",
    "prince george-valemount": "Lib",
    "richmond-bridgeport": "New",
    "richmond centre": "NDP",
    "richmond-queensborough": "NDP",
    "richmond-steveston": "NDP",
    "saanich north and the islands": "Green",
    "saanich south": "NDP",
    "shuswap-enderby": "Lib",
    "skeena": "Lib",
    "south cariboo": "Lib",
    "south okanagan-west kootenay": "NDP",
    "surrey city centre": "NDP",
    "surrey-cloverdale": "NDP",
    "surrey-fleetwood": "NDP",
    "surrey-green timbers": "NDP",
    "surrey-guildford": "NDP",
    "surrey-newton": "NDP",
    "surrey north": "NDP",
    "surrey-panorama": "NDP",
    "surrey-serpentine river": "New",
    "surrey south": "Lib",
    "surrey-white rock": "Lib",
    "vancouver-fraserview": "NDP",
    "vancouver-hastings": "NDP",
    "vancouver-kensington": "NDP",
    "vancouver-langara": "Lib",
    "vancouver-little mountain": "NDP",
    "vancouver-point grey": "NDP",
    "vancouver-renfrew": "NDP",
    "vancouver-south granville": "NDP",
    "vancouver-strathcona": "NDP",
    "vancouver-west end": "NDP",
    "vancouver-yaletown": "New",
    "vernon-lumby": "NDP",
    "victoria-beacon hill": "NDP",
    "victoria-swan lake": "NDP",
    "west kelowna-peachland": "Lib",
    "west vancouver-capilano": "Lib",
    "west vancouver-sea to sky": "Lib"
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
            # Fallback using party votes from main table
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

        # Historical comparison
        prev_party = HISTORICAL_2020.get(norm_key, "Unknown")
        if prev_party == "New":
            is_flip = False
            flip_text = "New District (2023 Redistribution)"
        elif prev_party == "Lib" and winner_party != "BC Liberal":
            is_flip = True
            flip_text = f"Shifted from BC Liberal to {winner_party}"
        elif prev_party == "NDP" and winner_party != "BC NDP":
            is_flip = True
            flip_text = f"Flipped from NDP to {winner_party}"
        elif prev_party == "Green" and winner_party != "BC Green":
            is_flip = True
            flip_text = f"Flipped from Green to {winner_party}"
        elif winner_party == "Independent":
            is_flip = False
            flip_text = "Pending"
        else:
            is_flip = False
            flip_text = f"{winner_party} Hold"

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
            "flip_description": flip_text,
            "prev_party": prev_party,
            "turnout_pct": round((tot_valid / 38000 * 100), 1),  # preliminary estimate against avg registered
            "total_votes": tot_valid,
            "rejected_ballots": rejected,
            "runner_up_party": runner_up["party"] if runner_up else None,
            "runner_up_candidate": runner_up["name"] if runner_up else None,
            "runner_up_votes": runner_up["votes"] if runner_up else 0,
            "candidates": cands
        })

    ridings.sort(key=lambda r: r["name"])

    # Party Summaries
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

    overall_poll_progress = round((total_boxes_reported / total_boxes_count * 100), 1) if total_boxes_count > 0 else 0

    return {
        "metadata": {
            "title": "British Columbia General Election - Live Night Reporting",
            "source": "Elections BC (results.elections.bc.ca)",
            "source_url": EBC_RESULTS_URL,
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
            "total_flips": len([r for r in ridings if r["is_flip"]]),
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
        print(f"Seats: NDP {data['parties']['BC NDP']['seats']} | CON {data['parties']['BC Conservative']['seats']} | GRN {data['parties']['BC Green']['seats']}")
    except Exception as e:
        print(f"Error scraping live results: {e}", file=sys.stderr)
        if not os.path.exists(OUTPUT_PATH):
            sys.exit(1)

if __name__ == "__main__":
    main()
