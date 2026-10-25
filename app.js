/**
 * British Columbia Election Results - Cloud Dashboard Engine
 * Handles GIS mapping, live data polling, candidate inspections, and battleground analysis.
 */

(function () {
  'use strict';

  // State
  let electionData = null;
  let geojsonData = null;
  let map = null;
  let geojsonLayer = null;
  let districtLayersMap = {};
  let currentActiveDistrict = null;
  let currentMapFilter = 'all';
  let tableSortField = 'name';
  let tableSortAsc = true;

  const PARTY_COLORS = {
    'BC NDP': '#f58220',
    'BC Conservative': '#1e60b8',
    'BC Green': '#2ea043',
    'Independent': '#8b949e'
  };

  const PARTY_LIGHT_COLORS = {
    'BC NDP': '#ffaa5c',
    'BC Conservative': '#60a5fa',
    'BC Green': '#86efac',
    'Independent': '#cbd5e1'
  };

  const REGION_BOUNDS = {
    bc: { center: [54.0, -125.0], zoom: 5 },
    vancouver: { center: [49.25, -122.95], zoom: 10 },
    victoria: { center: [48.45, -123.4], zoom: 11 },
    interior: { center: [50.0, -119.5], zoom: 8 },
    north: { center: [55.5, -126.0], zoom: 6 }
  };

  // DOM Elements
  const lastUpdatedEl = document.getElementById('last-updated-text');
  const refreshBtn = document.getElementById('refresh-btn');
  const ridingDrawer = document.getElementById('riding-drawer');
  const drawerCloseBtn = document.getElementById('drawer-close');
  const globalSearchInput = document.getElementById('global-riding-search');
  const searchDropdown = document.getElementById('search-dropdown');
  const partyTableFilter = document.getElementById('party-table-filter');

  // Initialize
  async function init() {
    setupTabNavigation();
    setupModal();
    setupDrawer();
    setupSearch();
    setupTableSorting();

    await loadData();
    initMap();
    renderAllViews();

    // Setup periodic data check (every 60 seconds)
    setInterval(checkForUpdates, 60000);

    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('loading');
        await checkForUpdates();
        refreshBtn.classList.remove('loading');
      });
    }
  }

  // Load GeoJSON and Results Data
  async function loadData() {
    try {
      const cacheBust = `?t=${Date.now()}`;
      const [resResults, resGeo] = await Promise.all([
        fetch(`data/results.json${cacheBust}`),
        fetch(`data/bc_districts.geojson${cacheBust}`)
      ]);

      if (!resResults.ok) throw new Error(`HTTP error ${resResults.status} loading results`);
      if (!resGeo.ok) throw new Error(`HTTP error ${resGeo.status} loading geojson`);

      electionData = await resResults.json();
      geojsonData = await resGeo.json();
      console.log('Successfully loaded election data & GeoJSON boundaries');
    } catch (err) {
      console.error('Failed to fetch data:', err);
      if (lastUpdatedEl) lastUpdatedEl.textContent = 'Error loading data';
    }
  }

  // Periodic poll for updates
  async function checkForUpdates() {
    try {
      const cacheBust = `?t=${Date.now()}`;
      const res = await fetch(`data/results.json${cacheBust}`);
      if (!res.ok) return;
      const freshData = await res.json();

      if (JSON.stringify(freshData.metadata) !== JSON.stringify(electionData?.metadata)) {
        console.log('Fresh election results detected!');
        electionData = freshData;
        renderAllViews();
        if (geojsonLayer) {
          geojsonLayer.setStyle(getDistrictStyle);
        }
      } else {
        updateTimeDisplay();
      }
    } catch (e) {
      console.warn('Update check failed:', e);
    }
  }

  // Time display formatting
  function updateTimeDisplay() {
    if (!lastUpdatedEl || !electionData?.metadata?.last_updated) return;
    const updated = new Date(electionData.metadata.last_updated);
    const diffMins = Math.round((Date.now() - updated.getTime()) / 60000);
    if (diffMins <= 1) {
      lastUpdatedEl.textContent = 'Updated just now';
    } else if (diffMins < 60) {
      lastUpdatedEl.textContent = `Updated ${diffMins}m ago`;
    } else {
      lastUpdatedEl.textContent = `Updated ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }

  // =====================================================================
  // MAP INITIALIZATION & RENDERING
  // =====================================================================
  function initMap() {
    const mapEl = document.getElementById('bc-map');
    if (!mapEl || !geojsonData) return;

    map = L.map('bc-map', {
      zoomControl: true,
      minZoom: 4,
      maxZoom: 14
    }).setView(REGION_BOUNDS.bc.center, REGION_BOUNDS.bc.zoom);

    // 1. Esri World Dark Gray Canvas (Default - No API key required)
    const esriDark = L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
      maxZoom: 16
    });

    // 2. OpenStreetMap Standard (Free, open - No API key required)
    const osmStandard = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    });

    // 3. Esri World Imagery (Satellite - No API key required)
    const esriSatellite = L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 18
    });

    // Add Esri Dark by default
    esriDark.addTo(map);

    // Optional layer control to switch between free basemaps
    const baseMaps = {
      "Dark Canvas (Esri)": esriDark,
      "Street Map (OSM)": osmStandard,
      "Satellite (Esri)": esriSatellite
    };
    L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

    renderGeoJsonLayer();
    setupMapControls();
  }

  function getDistrictResult(nameOrCode) {
    if (!electionData || !electionData.ridings) return null;
    const q = nameOrCode.toLowerCase().trim();
    return electionData.ridings.find(r => r.name.toLowerCase() === q || (r.code && r.code.toLowerCase() === q));
  }

  function getDistrictStyle(feature) {
    const districtName = feature.properties.name || '';
    const res = getDistrictResult(districtName);

    if (!res) {
      return {
        fillColor: '#334155',
        weight: 1,
        opacity: 0.8,
        color: '#1e293b',
        fillOpacity: 0.6
      };
    }

    // Apply Filter visibility
    if (currentMapFilter !== 'all') {
      if (currentMapFilter === 'battlegrounds' && !res.is_battleground) {
        return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
      }
      if (currentMapFilter === 'flips' && !res.is_flip) {
        return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
      }
      if (['BC NDP', 'BC Conservative', 'BC Green'].includes(currentMapFilter) && res.winner_party !== currentMapFilter) {
        return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
      }
    }

    const partyColor = PARTY_COLORS[res.winner_party] || '#8b949e';
    const isSelected = currentActiveDistrict && currentActiveDistrict.name === res.name;

    return {
      fillColor: partyColor,
      weight: isSelected ? 3 : 1.2,
      opacity: 1,
      color: isSelected ? '#ffffff' : '#0a0e17',
      fillOpacity: res.is_battleground && currentMapFilter === 'all' ? 0.95 : 0.78
    };
  }

  function renderGeoJsonLayer() {
    if (geojsonLayer) {
      map.removeLayer(geojsonLayer);
    }
    districtLayersMap = {};

    geojsonLayer = L.geoJSON(geojsonData, {
      style: getDistrictStyle,
      onEachFeature: (feature, layer) => {
        const districtName = feature.properties.name;
        districtLayersMap[districtName.toLowerCase()] = layer;

        const res = getDistrictResult(districtName);

        // Hover tooltip
        if (res) {
          const tooltipContent = `
            <div class="map-tooltip-content">
              <div class="tooltip-title">${res.name}</div>
              <div class="tooltip-winner">
                <span class="legend-chip" style="background:${PARTY_COLORS[res.winner_party]};"></span>
                <span>${res.winner_party} (${res.winner_share}%)</span>
              </div>
              <div class="tooltip-margin">Margin: ${res.margin_votes.toLocaleString()} votes (${res.margin_pct}%)</div>
            </div>
          `;
          layer.bindTooltip(tooltipContent, {
            sticky: true,
            className: 'custom-map-tooltip',
            direction: 'auto'
          });
        }

        // Layer event listeners
        layer.on({
          mouseover: (e) => {
            const l = e.target;
            if (!currentActiveDistrict || currentActiveDistrict.name !== districtName) {
              l.setStyle({
                weight: 2.5,
                color: '#ffffff',
                fillOpacity: 0.95
              });
              if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                l.bringToFront();
              }
            }
          },
          mouseout: (e) => {
            if (!currentActiveDistrict || currentActiveDistrict.name !== districtName) {
              geojsonLayer.resetStyle(e.target);
            }
          },
          click: () => {
            selectDistrict(districtName);
          }
        });
      }
    }).addTo(map);
  }

  function setupMapControls() {
    // Zoom region pills
    document.querySelectorAll('.zoom-pill').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.zoom-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const region = btn.dataset.zoom;
        if (REGION_BOUNDS[region] && map) {
          map.flyTo(REGION_BOUNDS[region].center, REGION_BOUNDS[region].zoom, { duration: 1.2 });
        }
      });
    });

    // Filter pills
    document.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMapFilter = btn.dataset.filter;
        if (geojsonLayer) {
          geojsonLayer.setStyle(getDistrictStyle);
        }
      });
    });
  }

  // =====================================================================
  // DISTRICT SELECTION & DRAWER INSPECTOR
  // =====================================================================
  function selectDistrict(districtName) {
    const res = getDistrictResult(districtName);
    if (!res) return;

    currentActiveDistrict = res;

    // Reset style on all, highlight current
    if (geojsonLayer) {
      geojsonLayer.setStyle(getDistrictStyle);
    }

    const layer = districtLayersMap[districtName.toLowerCase()];
    if (layer && map) {
      map.flyToBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 11, duration: 0.8 });
    }

    populateDrawer(res);
    openDrawer();
  }

  function populateDrawer(res) {
    const titleEl = document.getElementById('drawer-title');
    const codeEl = document.getElementById('drawer-code');
    const tagsEl = document.getElementById('drawer-tags');
    const contentEl = document.getElementById('drawer-content');

    if (!titleEl || !contentEl) return;

    titleEl.textContent = res.name;
    codeEl.textContent = res.code || 'ED';

    // Tags
    tagsEl.innerHTML = '';
    if (res.is_battleground) {
      const bTag = document.createElement('span');
      bTag.className = 'drawer-tag tag-battleground';
      bTag.textContent = `Battleground (${res.margin_pct}%)`;
      tagsEl.appendChild(bTag);
    }
    if (res.is_flip) {
      const fTag = document.createElement('span');
      fTag.className = 'drawer-tag tag-flip';
      fTag.textContent = 'Seat Flipped';
      tagsEl.appendChild(fTag);
    }

    const partyColor = PARTY_COLORS[res.winner_party] || '#8b949e';
    const borderClass = res.winner_party === 'BC NDP' ? 'ndp-border' : (res.winner_party === 'BC Conservative' ? 'con-border' : 'grn-border');

    let html = `
      <div class="winner-spotlight ${borderClass}">
        <div class="winner-top-row">
          <span class="winner-elected-badge">Elected Candidate</span>
          <span class="party-tag" style="color:${partyColor}; font-weight:700;">${res.winner_party}</span>
        </div>
        <div class="winner-candidate-name">${res.winning_candidate}</div>
        <div class="winner-party-name" style="color:var(--text-muted);">${res.winner_party}</div>
        <div class="winner-stats-row">
          <div class="kpi-stat">
            <span class="stat-label">Votes Won</span>
            <span class="stat-val">${res.winner_votes.toLocaleString()}</span>
          </div>
          <div class="kpi-stat">
            <span class="stat-label">Vote Share</span>
            <span class="stat-val" style="color:${partyColor};">${res.winner_share}%</span>
          </div>
          <div class="kpi-stat">
            <span class="stat-label">Victory Margin</span>
            <span class="stat-val">+${res.margin_votes.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div class="candidates-breakdown-card">
        <h3>Candidate Vote Breakdown</h3>
    `;

    (res.candidates || []).forEach(c => {
      const cColor = PARTY_COLORS[c.party] || '#8b949e';
      html += `
        <div class="candidate-row">
          <div class="cand-meta">
            <div class="cand-name-party">
              <span>${c.name}</span>
              <span class="cand-party-code">(${c.party})</span>
              ${c.elected ? '<span style="color:#4ade80;font-size:0.75rem;margin-left:4px;">&#10003;</span>' : ''}
            </div>
            <div class="cand-numbers">
              <span>${c.votes.toLocaleString()}</span>
              <span style="color:${cColor};margin-left:6px;">${c.pct}%</span>
            </div>
          </div>
          <div class="cand-bar-bg">
            <div class="cand-bar-fill" style="width: ${c.pct}%; background-color: ${cColor};"></div>
          </div>
        </div>
      `;
    });

    html += `
      </div>

      <div class="drawer-meta-grid">
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Previous Representation (2020)</div>
          <div class="drawer-meta-val">${res.prev_party}</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Flip Status</div>
          <div class="drawer-meta-val" style="font-size:0.8rem;">${res.flip_description}</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Voter Turnout</div>
          <div class="drawer-meta-val">${res.turnout_pct}%</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Total Valid Votes</div>
          <div class="drawer-meta-val">${res.total_votes.toLocaleString()}</div>
        </div>
      </div>
    `;

    contentEl.innerHTML = html;
  }

  function openDrawer() {
    if (ridingDrawer) ridingDrawer.classList.add('open');
  }

  function closeDrawer() {
    if (ridingDrawer) ridingDrawer.classList.remove('open');
    currentActiveDistrict = null;
    if (geojsonLayer) {
      geojsonLayer.setStyle(getDistrictStyle);
    }
  }

  function setupDrawer() {
    if (drawerCloseBtn) {
      drawerCloseBtn.addEventListener('click', closeDrawer);
    }
  }

  // =====================================================================
  // ALL VIEWS RENDERING (HEADER, CARDS, BATTLEGROUNDS, FLIPS, TABLE, ANALYSIS)
  // =====================================================================
  function renderAllViews() {
    if (!electionData) return;
    renderHeaderMetrics();
    renderKpiCards();
    renderBattlegroundsView();
    renderFlipsView();
    renderTable();
    renderAnalysisView();
    updateTimeDisplay();
  }

  function renderHeaderMetrics() {
    const p = electionData.parties;
    if (!p) return;

    const ndpSeats = p['BC NDP']?.seats || 0;
    const conSeats = p['BC Conservative']?.seats || 0;
    const grnSeats = p['BC Green']?.seats || 0;
    const othSeats = p['Independent']?.seats || 0;
    const totalSeats = electionData.metadata?.total_seats || 93;

    const tNdp = document.getElementById('tracker-ndp-seats');
    const tCon = document.getElementById('tracker-con-seats');
    if (tNdp) tNdp.textContent = ndpSeats;
    if (tCon) tCon.textContent = conSeats;

    const mNdp = document.getElementById('meter-ndp');
    const mCon = document.getElementById('meter-con');
    const mGrn = document.getElementById('meter-grn');
    const mOth = document.getElementById('meter-oth');

    if (mNdp) mNdp.style.width = `${(ndpSeats / totalSeats) * 100}%`;
    if (mCon) mCon.style.width = `${(conSeats / totalSeats) * 100}%`;
    if (mGrn) mGrn.style.width = `${(grnSeats / totalSeats) * 100}%`;
    if (mOth) mOth.style.width = `${(othSeats / totalSeats) * 100}%`;
  }

  function renderKpiCards() {
    const p = electionData.parties;
    const meta = electionData.metadata;
    if (!p) return;

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setText('kpi-ndp-seats', p['BC NDP']?.seats || 0);
    setText('kpi-ndp-pct', `${p['BC NDP']?.vote_share_pct || 0}%`);
    setText('kpi-ndp-votes', (p['BC NDP']?.votes || 0).toLocaleString());

    setText('kpi-con-seats', p['BC Conservative']?.seats || 0);
    setText('kpi-con-pct', `${p['BC Conservative']?.vote_share_pct || 0}%`);
    setText('kpi-con-votes', (p['BC Conservative']?.votes || 0).toLocaleString());

    setText('kpi-grn-seats', p['BC Green']?.seats || 0);
    setText('kpi-grn-pct', `${p['BC Green']?.vote_share_pct || 0}%`);
    setText('kpi-grn-votes', (p['BC Green']?.votes || 0).toLocaleString());

    setText('kpi-turnout-pct', `${meta?.provincial_turnout_pct || 58.45}%`);
    setText('kpi-total-votes', (meta?.total_votes_cast || 0).toLocaleString());
    setText('kpi-battlegrounds', electionData.summary?.total_battlegrounds || 0);
    setText('kpi-flips', electionData.summary?.total_flips || 0);

    const bBadge = document.getElementById('tab-badge-battleground');
    if (bBadge) bBadge.textContent = electionData.summary?.total_battlegrounds || 17;
  }

  function renderBattlegroundsView() {
    const container = document.getElementById('battlegrounds-container');
    if (!container || !electionData?.ridings) return;

    const battlegrounds = electionData.ridings
      .filter(r => r.is_battleground)
      .sort((a, b) => a.margin_pct - b.margin_pct);

    container.innerHTML = battlegrounds.map(r => {
      const winnerColor = PARTY_COLORS[r.winner_party] || '#8b949e';
      const runnerColor = PARTY_COLORS[r.runner_up_party] || '#8b949e';

      return `
        <div class="battleground-card" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">
          <div class="bg-card-header">
            <span class="bg-riding-name">${r.name}</span>
            <span class="bg-margin-badge">+${r.margin_votes.toLocaleString()} votes (${r.margin_pct}%)</span>
          </div>
          <div class="bg-candidates-comparison">
            <div class="bg-cand-row">
              <span class="bg-cand-name" style="color:${winnerColor};">&#10003; ${r.winning_candidate} (${r.winner_party})</span>
              <span class="stat-val">${r.winner_votes.toLocaleString()} (${r.winner_share}%)</span>
            </div>
            <div class="cand-bar-bg">
              <div class="cand-bar-fill" style="width: ${r.winner_share}%; background-color: ${winnerColor};"></div>
            </div>
            <div class="bg-cand-row" style="margin-top: 4px;">
              <span class="bg-cand-name" style="color:var(--text-muted);">${r.runner_up_candidate || 'Runner-up'} (${r.runner_up_party || ''})</span>
              <span class="stat-val" style="color:var(--text-muted);">${(r.runner_up_votes || 0).toLocaleString()}</span>
            </div>
          </div>
          <div style="font-size:0.75rem; color:var(--text-dim); display:flex; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.05); padding-top:8px;">
            <span>${r.flip_description}</span>
            <span>Turnout: ${r.turnout_pct}%</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderFlipsView() {
    const tbody = document.getElementById('flips-tbody');
    if (!tbody || !electionData?.ridings) return;

    const flips = electionData.ridings
      .filter(r => r.is_flip)
      .sort((a, b) => a.name.localeCompare(b.name));

    tbody.innerHTML = flips.map(r => {
      const winnerColor = PARTY_COLORS[r.winner_party] || '#8b949e';
      return `
        <tr>
          <td><span class="riding-table-name" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">${r.name}</span></td>
          <td><span class="party-badge-inline" style="background:rgba(255,255,255,0.06);color:var(--text-muted);">${r.prev_party}</span></td>
          <td><span style="color:var(--accent-blue);font-weight:700;">&rarr;</span></td>
          <td><span class="party-badge-inline" style="background:${winnerColor}25;color:${winnerColor};border:1px solid ${winnerColor}50;">${r.winner_party}</span></td>
          <td><strong>${r.winning_candidate}</strong></td>
          <td style="font-family:var(--font-mono);">${r.winner_votes.toLocaleString()} (${r.winner_share}%)</td>
          <td style="font-family:var(--font-mono);color:${r.is_battleground ? 'var(--accent-amber)' : 'inherit'};">+${r.margin_votes.toLocaleString()} (${r.margin_pct}%)</td>
          <td style="font-family:var(--font-mono);">${r.turnout_pct}%</td>
        </tr>
      `;
    }).join('');
  }

  function renderTable() {
    const tbody = document.getElementById('all-ridings-tbody');
    if (!tbody || !electionData?.ridings) return;

    const filterVal = partyTableFilter ? partyTableFilter.value : 'all';
    let ridings = [...electionData.ridings];

    if (filterVal !== 'all') {
      ridings = ridings.filter(r => r.winner_party === filterVal);
    }

    // Sort
    ridings.sort((a, b) => {
      let valA = a[tableSortField];
      let valB = b[tableSortField];
      if (typeof valA === 'string') {
        return tableSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return tableSortAsc ? valA - valB : valB - valA;
    });

    tbody.innerHTML = ridings.map(r => {
      const partyColor = PARTY_COLORS[r.winner_party] || '#8b949e';
      return `
        <tr>
          <td><span class="riding-table-name" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">${r.name}</span></td>
          <td><span class="party-badge-inline" style="background:${partyColor}25;color:${partyColor};border:1px solid ${partyColor}50;">${r.winner_party}</span></td>
          <td><strong>${r.winning_candidate}</strong></td>
          <td style="font-family:var(--font-mono);">${r.winner_votes.toLocaleString()}</td>
          <td style="font-family:var(--font-mono);">${r.winner_share}%</td>
          <td style="font-family:var(--font-mono);color:${r.is_battleground ? 'var(--accent-amber)' : 'inherit'};">+${r.margin_votes.toLocaleString()}</td>
          <td style="font-family:var(--font-mono);color:${r.is_battleground ? 'var(--accent-amber)' : 'inherit'};">${r.margin_pct}%</td>
          <td>${r.runner_up_candidate ? `${r.runner_up_candidate} (${r.runner_up_party})` : '—'}</td>
          <td style="font-family:var(--font-mono);">${r.turnout_pct}%</td>
          <td style="font-family:var(--font-mono);">${r.total_votes.toLocaleString()}</td>
        </tr>
      `;
    }).join('');
  }

  function setupTableSorting() {
    document.querySelectorAll('#all-ridings-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (tableSortField === field) {
          tableSortAsc = !tableSortAsc;
        } else {
          tableSortField = field;
          tableSortAsc = true;
        }
        renderTable();
      });
    });

    if (partyTableFilter) {
      partyTableFilter.addEventListener('change', renderTable);
    }
  }

  function renderAnalysisView() {
    const container = document.getElementById('comparison-bars');
    if (!container || !electionData?.parties) return;

    const parties = ['BC NDP', 'BC Conservative', 'BC Green'];
    const totalSeats = electionData.metadata?.total_seats || 93;

    container.innerHTML = parties.map(pKey => {
      const p = electionData.parties[pKey];
      if (!p) return '';
      const color = PARTY_COLORS[pKey];
      const seatPct = ((p.seats / totalSeats) * 100).toFixed(1);
      const votePct = p.vote_share_pct.toFixed(1);

      return `
        <div class="comp-party-item">
          <div class="comp-party-header">
            <span style="color:${color};font-weight:700;">${p.name}</span>
            <span style="font-family:var(--font-mono);">${p.seats} Seats (${seatPct}%)</span>
          </div>
          <div class="comp-bar-container">
            <div class="comp-bar-row">
              <span class="comp-bar-label">Seats Share</span>
              <div class="comp-bar-track">
                <div class="comp-bar-fill" style="width:${seatPct}%; background-color:${color};"></div>
              </div>
              <span class="comp-bar-val" style="color:${color};">${seatPct}%</span>
            </div>
            <div class="comp-bar-row">
              <span class="comp-bar-label">Popular Vote</span>
              <div class="comp-bar-track">
                <div class="comp-bar-fill" style="width:${votePct}%; background-color:${PARTY_LIGHT_COLORS[pKey] || color}; opacity:0.8;"></div>
              </div>
              <span class="comp-bar-val">${votePct}%</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // =====================================================================
  // NAVIGATION, SEARCH & MODAL HELPERS
  // =====================================================================
  function setupTabNavigation() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const targetTab = document.getElementById(btn.dataset.tab);
        if (targetTab) targetTab.classList.add('active');

        // Trigger map resize if switching to map
        if (btn.dataset.tab === 'tab-map' && map) {
          setTimeout(() => { map.invalidateSize(); }, 150);
        }
      });
    });
  }

  function setupSearch() {
    if (!globalSearchInput || !searchDropdown) return;

    globalSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q || !electionData?.ridings) {
        searchDropdown.classList.add('hidden');
        return;
      }

      const matches = electionData.ridings.filter(r => {
        return r.name.toLowerCase().includes(q) ||
               (r.code && r.code.toLowerCase().includes(q)) ||
               r.winning_candidate.toLowerCase().includes(q) ||
               (r.candidates && r.candidates.some(c => c.name.toLowerCase().includes(q)));
      }).slice(0, 8);

      if (matches.length === 0) {
        searchDropdown.innerHTML = `<div style="padding:10px;color:var(--text-dim);font-size:0.8rem;">No districts found matching "${q}"</div>`;
        searchDropdown.classList.remove('hidden');
        return;
      }

      searchDropdown.innerHTML = matches.map(r => {
        const partyColor = PARTY_COLORS[r.winner_party] || '#8b949e';
        return `
          <div class="search-item" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">
            <div>
              <div style="font-weight:700;">${r.name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);">${r.winning_candidate}</div>
            </div>
            <span class="search-item-party" style="background:${partyColor}25;color:${partyColor};border:1px solid ${partyColor}50;">
              ${r.winner_party}
            </span>
          </div>
        `;
      }).join('');

      searchDropdown.classList.remove('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!globalSearchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
        searchDropdown.classList.add('hidden');
      }
    });
  }

  function setupModal() {
    const aboutBtn = document.getElementById('about-btn');
    const aboutModal = document.getElementById('about-modal');
    const modalClose = document.getElementById('modal-close');

    if (aboutBtn && aboutModal) {
      aboutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        aboutModal.classList.remove('hidden');
      });
    }

    if (modalClose && aboutModal) {
      modalClose.addEventListener('click', () => {
        aboutModal.classList.add('hidden');
      });
    }

    if (aboutModal) {
      aboutModal.addEventListener('click', (e) => {
        if (e.target === aboutModal) {
          aboutModal.classList.add('hidden');
        }
      });
    }
  }

  // Global window handler for riding click
  window.selectRiding = function (name) {
    // Switch to map tab if not active
    const mapTabBtn = document.querySelector('.tab-btn[data-tab="tab-map"]');
    if (mapTabBtn && !mapTabBtn.classList.contains('active')) {
      mapTabBtn.click();
    }
    if (searchDropdown) searchDropdown.classList.add('hidden');
    if (globalSearchInput) globalSearchInput.value = '';

    setTimeout(() => {
      selectDistrict(name);
    }, 150);
  };

  // Launch on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();
