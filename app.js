/**
 * British Columbia Election Results - Cloud Dashboard Engine
 * Handles GIS mapping, live data polling, candidate inspections, battleground analysis,
 * and 2024 partisan swing visualization.
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
  let currentSwingFilter = 'all';
  let mapViewMode = 'party'; // 'party' or 'swing'
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
          updateTooltips();
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

    esriDark.addTo(map);

    const baseMaps = {
      "Dark Canvas (Esri)": esriDark,
      "Street Map (OSM)": osmStandard,
      "Satellite (Esri)": esriSatellite
    };
    L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

    renderGeoJsonLayer();
    setupMapControls();
    updateMapLegend();

    // Deselect riding and close drawer when clicking on the map background
    map.on('click', () => {
      if (ridingDrawer && ridingDrawer.classList.contains('open')) {
        closeDrawer();
      }
    });
  }

  function getDistrictResult(nameOrCode) {
    if (!electionData || !electionData.ridings) return null;
    const q = nameOrCode.toLowerCase().trim();
    return electionData.ridings.find(r => r.name.toLowerCase() === q || (r.code && r.code.toLowerCase() === q));
  }

  // Diverging color scale for 2024 swing
  function getSwingColor(netConSwing) {
    if (netConSwing === undefined || netConSwing === null) return '#475569';
    if (netConSwing > 15) return '#084081';  // Deep Conservative Blue (>15%)
    if (netConSwing > 10) return '#2171b5';  // Strong Conservative Blue (10-15%)
    if (netConSwing > 5)  return '#4eb3d3';  // Medium Conservative Blue (5-10%)
    if (netConSwing > 1.5) return '#7bccc4'; // Soft Conservative Teal (1.5-5%)
    if (netConSwing >= -1.5) return '#475569'; // Neutral (±1.5%)
    if (netConSwing >= -5) return '#fdbb84'; // Soft NDP Orange (1.5-5%)
    if (netConSwing >= -10) return '#fc8d59'; // Medium NDP Orange (5-10%)
    if (netConSwing >= -15) return '#e34a33'; // Strong NDP Orange (10-15%)
    return '#b30000'; // Deep NDP Crimson (>15%)
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

    const isSelected = currentActiveDistrict && currentActiveDistrict.name === res.name;

    // --- SWING MODE ---
    if (mapViewMode === 'swing') {
      const netSwing = res.swing ? res.swing.net_con_swing : 0;
      const fillColor = getSwingColor(netSwing);

      // Swing filter visibility
      if (currentSwingFilter !== 'all') {
        if (currentSwingFilter === 'con-strong' && netSwing <= 10) {
          return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
        }
        if (currentSwingFilter === 'con-mod' && (netSwing < 5 || netSwing > 10)) {
          return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
        }
        if (currentSwingFilter === 'neutral' && Math.abs(netSwing) > 1.5) {
          return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
        }
        if (currentSwingFilter === 'ndp-swing' && netSwing >= -1.5) {
          return { fillOpacity: 0.08, weight: 0.5, color: '#334155', fillColor: '#1e293b' };
        }
      }

      return {
        fillColor: fillColor,
        weight: isSelected ? 3 : 1.2,
        opacity: 1,
        color: isSelected ? '#ffffff' : '#0a0e17',
        fillOpacity: 0.85
      };
    }

    // --- PARTY WINNER MODE ---
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

    return {
      fillColor: partyColor,
      weight: isSelected ? 3 : 1.2,
      opacity: 1,
      color: isSelected ? '#ffffff' : '#0a0e17',
      fillOpacity: res.is_battleground && currentMapFilter === 'all' ? 0.95 : 0.82
    };
  }

  function getTooltipHtml(res) {
    if (!res) return '';

    if (mapViewMode === 'swing' && res.swing) {
      const s = res.swing;
      const net = s.net_con_swing;
      const sign = net > 0 ? '+' : '';
      const swingBadgeColor = net > 1.5 ? '#60a5fa' : (net < -1.5 ? '#ffaa5c' : '#94a3b8');
      const swingTitle = net > 1.5 ? 'Conservative Swing' : (net < -1.5 ? 'NDP Swing' : 'Neutral Shift');

      return `
        <div class="map-tooltip-content">
          <div class="tooltip-title">${res.name}</div>
          <div style="font-size:0.85rem; font-weight:700; color:${swingBadgeColor}; margin-bottom:6px;">
            ${sign}${net.toFixed(1)}% ${swingTitle}
          </div>
          <div style="font-size:0.75rem; color:var(--text-muted); line-height:1.45;">
            <div><strong>Con:</strong> ${s.cur_con_pct}% <span style="color:${s.con_shift >= 0 ? '#60a5fa' : '#ef4444'};">(${s.con_shift >= 0 ? '+' : ''}${s.con_shift}%)</span> [2024: ${s.base_con_pct}%]</div>
            <div><strong>NDP:</strong> ${s.cur_ndp_pct}% <span style="color:${s.ndp_shift >= 0 ? '#ffaa5c' : '#ef4444'};">(${s.ndp_shift >= 0 ? '+' : ''}${s.ndp_shift}%)</span> [2024: ${s.base_ndp_pct}%]</div>
            ${s.base_grn_pct > 0 || s.cur_grn_pct > 0 ? `<div><strong>Grn:</strong> ${s.cur_grn_pct}% <span style="color:#86efac;">(${s.grn_shift >= 0 ? '+' : ''}${s.grn_shift}%)</span> [2024: ${s.base_grn_pct}%]</div>` : ''}
          </div>
        </div>
      `;
    }

    // Party mode tooltip
    return `
      <div class="map-tooltip-content">
        <div class="tooltip-title">${res.name}</div>
        <div class="tooltip-winner">
          <span class="legend-chip" style="background:${PARTY_COLORS[res.winner_party]};"></span>
          <span>${res.winner_party} (${res.winner_share}%)</span>
        </div>
        <div class="tooltip-margin">Margin: ${res.margin_votes.toLocaleString()} votes (${res.margin_pct}%)</div>
        <div style="font-size:0.72rem;color:var(--text-dim);margin-top:2px;">Polls: ${res.status}</div>
      </div>
    `;
  }

  function updateTooltips() {
    if (!geojsonLayer) return;
    geojsonLayer.eachLayer(layer => {
      const name = layer.feature?.properties?.name;
      if (!name) return;
      const res = getDistrictResult(name);
      if (res) {
        layer.setTooltipContent(getTooltipHtml(res));
      }
    });
  }

  function updateMapLegend() {
    const legendEl = document.querySelector('.map-legend');
    if (!legendEl) return;

    if (mapViewMode === 'swing') {
      legendEl.innerHTML = `
        <h4>Partisan Swing vs. 2024</h4>
        <div class="legend-note" style="margin-bottom:6px;">Net margin shift (NDP &harr; Conservative)</div>
        <div class="swing-legend-bar">
          <div class="swing-stop" style="background:#b30000;" title=">15% NDP Swing"></div>
          <div class="swing-stop" style="background:#e34a33;" title="10-15% NDP Swing"></div>
          <div class="swing-stop" style="background:#fc8d59;" title="5-10% NDP Swing"></div>
          <div class="swing-stop" style="background:#fdbb84;" title="1.5-5% NDP Swing"></div>
          <div class="swing-stop" style="background:#475569;" title="Neutral (±1.5%)"></div>
          <div class="swing-stop" style="background:#7bccc4;" title="1.5-5% Con Swing"></div>
          <div class="swing-stop" style="background:#4eb3d3;" title="5-10% Con Swing"></div>
          <div class="swing-stop" style="background:#2171b5;" title="10-15% Con Swing"></div>
          <div class="swing-stop" style="background:#084081;" title=">15% Con Swing"></div>
        </div>
        <div class="swing-legend-labels">
          <span style="color:#ffaa5c;">&larr; NDP Swing</span>
          <span style="color:#94a3b8;">Neutral</span>
          <span style="color:#60a5fa;">Con Swing &rarr;</span>
        </div>
        <div class="legend-divider"></div>
        <div class="legend-note">Click district for before/after comparison.</div>
      `;
    } else {
      const p = electionData?.parties || {};
      legendEl.innerHTML = `
        <h4>Electoral Legend</h4>
        <div class="legend-row">
          <span class="legend-chip ndp-bg"></span>
          <span>BC NDP (${p['BC NDP']?.seats || 28})</span>
        </div>
        <div class="legend-row">
          <span class="legend-chip con-bg"></span>
          <span>BC Conservative (${p['BC Conservative']?.seats || 63})</span>
        </div>
        <div class="legend-row">
          <span class="legend-chip grn-bg"></span>
          <span>BC Green Party (${p['BC Green']?.seats || 2})</span>
        </div>
        <div class="legend-divider"></div>
        <div class="legend-note">Click any district for candidate details.</div>
      `;
    }
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

        layer.bindTooltip(() => {
          const r = getDistrictResult(districtName);
          return getTooltipHtml(r);
        }, {
          sticky: true,
          className: 'custom-map-tooltip',
          direction: 'auto'
        });

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
              e.target.setStyle(getDistrictStyle(e.target.feature));
            }
          },
          click: (e) => {
            if (e && e.originalEvent) {
              L.DomEvent.stopPropagation(e);
            }
            selectDistrict(districtName);
          }
        });
      }
    }).addTo(map);
  }

  // Global window functions for map controls (resilient against DOM timing)
  window.setMapMode = function (mode) {
    mapViewMode = mode;
    document.querySelectorAll('.mode-pill').forEach(b => {
      const bMode = b.dataset.mode || (b.id === 'btn-mode-party' ? 'party' : 'swing');
      b.classList.toggle('active', bMode === mode);
    });

    const partyFilters = document.getElementById('party-filters-group');
    const swingFilters = document.getElementById('swing-filters-group');

    if (mapViewMode === 'swing') {
      if (partyFilters) partyFilters.classList.add('hidden');
      if (swingFilters) swingFilters.classList.remove('hidden');
    } else {
      if (partyFilters) partyFilters.classList.remove('hidden');
      if (swingFilters) swingFilters.classList.add('hidden');
    }

    if (geojsonLayer) {
      geojsonLayer.setStyle(getDistrictStyle);
    }
    updateMapLegend();
  };

  window.setPartyFilter = function (filter, btnEl) {
    currentMapFilter = filter;
    document.querySelectorAll('#party-filters-group .filter-pill').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    if (geojsonLayer) {
      geojsonLayer.setStyle(getDistrictStyle);
    }
  };

  window.setSwingFilter = function (filter, btnEl) {
    currentSwingFilter = filter;
    document.querySelectorAll('#swing-filters-group .filter-pill').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    if (geojsonLayer) {
      geojsonLayer.setStyle(getDistrictStyle);
    }
  };

  window.zoomToRegion = function (region, btnEl) {
    document.querySelectorAll('.zoom-pill').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    if (REGION_BOUNDS[region] && map) {
      map.flyTo(REGION_BOUNDS[region].center, REGION_BOUNDS[region].zoom, { duration: 1.2 });
    }
  };

  function setupMapControls() {
    // Also attach standard event listeners as a secondary trigger
    document.querySelectorAll('.mode-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        window.setMapMode(btn.dataset.mode || (btn.id === 'btn-mode-party' ? 'party' : 'swing'));
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
      fTag.textContent = res.flip_badge || 'Seat Flipped';
      tagsEl.appendChild(fTag);
    }

    const partyColor = PARTY_COLORS[res.winner_party] || '#8b949e';
    const borderClass = res.winner_party === 'BC NDP' ? 'ndp-border' : (res.winner_party === 'BC Conservative' ? 'con-border' : 'grn-border');

    const s = res.swing || {};
    const net = s.net_con_swing || 0;
    const sign = net > 0 ? '+' : '';
    const swingBgClass = net > 1.5 ? 'swing-con-bg' : (net < -1.5 ? 'swing-ndp-bg' : 'swing-neutral-bg');
    const swingText = net > 1.5 ? `${sign}${net.toFixed(1)}% to Conservative` : (net < -1.5 ? `${sign}${net.toFixed(1)}% to NDP` : 'Neutral (±1.5%)');

    let html = `
      <div class="winner-spotlight ${borderClass}">
        <div class="winner-top-row">
          <span class="winner-elected-badge">${res.status.includes('Declared') ? 'Elected Candidate' : 'Currently Leading'}</span>
          <span class="party-tag" style="color:${partyColor}; font-weight:700;">${res.winner_party}</span>
        </div>
        <div class="winner-candidate-name">${res.winning_candidate}</div>
        <div class="winner-party-name" style="color:var(--text-muted);">${res.winner_party}</div>
        <div class="winner-stats-row">
          <div class="kpi-stat">
            <span class="stat-label">Votes Counted</span>
            <span class="stat-val">${res.winner_votes.toLocaleString()}</span>
          </div>
          <div class="kpi-stat">
            <span class="stat-label">Vote Share</span>
            <span class="stat-val" style="color:${partyColor};">${res.winner_share}%</span>
          </div>
          <div class="kpi-stat">
            <span class="stat-label">Current Margin</span>
            <span class="stat-val">+${res.margin_votes.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <!-- 2024 Swing Comparison Card -->
      <div class="swing-breakdown-card">
        <div class="swing-header-badge">
          <div>
            <h3 style="font-size:0.95rem; font-weight:700; color:#fff;">Swing vs. 2024 Baseline</h3>
            <div style="font-size:0.75rem; color:var(--text-muted);">Net margin shift between top parties</div>
          </div>
          <span class="swing-delta-pill ${swingBgClass}">${swingText}</span>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px;">
          <div class="swing-party-row">
            <div class="swing-row-meta">
              <span><strong>Conservative Party</strong></span>
              <span><strong>${s.cur_con_pct || 0}%</strong> (was ${s.base_con_pct || 0}%, <span style="color:${s.con_shift >= 0 ? '#60a5fa' : '#ef4444'};">${s.con_shift >= 0 ? '+' : ''}${s.con_shift || 0}%</span>)</span>
            </div>
            <div class="cand-bar-bg"><div class="cand-bar-fill" style="width:${s.cur_con_pct || 0}%; background-color:var(--con-color);"></div></div>
          </div>

          <div class="swing-party-row">
            <div class="swing-row-meta">
              <span><strong>BC NDP</strong></span>
              <span><strong>${s.cur_ndp_pct || 0}%</strong> (was ${s.base_ndp_pct || 0}%, <span style="color:${s.ndp_shift >= 0 ? '#ffaa5c' : '#ef4444'};">${s.ndp_shift >= 0 ? '+' : ''}${s.ndp_shift || 0}%</span>)</span>
            </div>
            <div class="cand-bar-bg"><div class="cand-bar-fill" style="width:${s.cur_ndp_pct || 0}%; background-color:var(--ndp-color);"></div></div>
          </div>

          ${(s.base_grn_pct > 0 || s.cur_grn_pct > 0) ? `
          <div class="swing-party-row">
            <div class="swing-row-meta">
              <span><strong>BC Green Party</strong></span>
              <span><strong>${s.cur_grn_pct || 0}%</strong> (was ${s.base_grn_pct || 0}%, <span style="color:#86efac;">${s.grn_shift >= 0 ? '+' : ''}${s.grn_shift || 0}%</span>)</span>
            </div>
            <div class="cand-bar-bg"><div class="cand-bar-fill" style="width:${s.cur_grn_pct || 0}%; background-color:var(--grn-color);"></div></div>
          </div>
          ` : ''}
        </div>
      </div>

      <div class="candidates-breakdown-card">
        <h3>Live Candidate Tallies</h3>
    `;

    (res.candidates || []).forEach(c => {
      const cColor = PARTY_COLORS[c.party] || '#8b949e';
      html += `
        <div class="candidate-row">
          <div class="cand-meta">
            <div class="cand-name-party">
              <span>${c.name}</span>
              <span class="cand-party-code">(${c.raw_affiliation || c.party})</span>
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
          <div class="drawer-meta-label">Ballot Boxes Counted</div>
          <div class="drawer-meta-val">${res.boxes_reported || 0} / ${res.boxes_total || 0} (${res.poll_progress_pct || 0}%)</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Reporting Status</div>
          <div class="drawer-meta-val" style="font-size:0.85rem;">${res.status}</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">2024 Election Baseline</div>
          <div class="drawer-meta-val">${res.party_2024 || res.prev_party}</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Seat Shift vs 2024</div>
          <div class="drawer-meta-val" style="font-size:0.8rem;">${res.flip_description}</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Total Valid Votes</div>
          <div class="drawer-meta-val">${res.total_votes.toLocaleString()}</div>
        </div>
        <div class="drawer-meta-item">
          <div class="drawer-meta-label">Rejected Ballots</div>
          <div class="drawer-meta-val">${(res.rejected_ballots || 0).toLocaleString()}</div>
        </div>
      </div>

      <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border-color);">
        <button type="button" class="btn btn-secondary" onclick="window.closeDrawer()" style="width:100%; justify-content:center; padding:10px 14px; font-weight:700; font-size:0.85rem; display:flex; align-items:center; gap:8px;">
          <span>&#10005;</span> Close Riding Details
        </button>
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

  // Expose globally so inline onclick handlers and outside callers can invoke it directly
  window.closeDrawer = closeDrawer;

  function setupDrawer() {
    if (drawerCloseBtn) {
      drawerCloseBtn.addEventListener('click', closeDrawer);
    }

    // Close drawer and deselect riding on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ridingDrawer && ridingDrawer.classList.contains('open')) {
        closeDrawer();
      }
    });
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
    const meta = electionData.metadata;
    if (!p) return;

    const statusLabel = document.getElementById('status-label');
    if (statusLabel && meta) {
      if (meta.overall_poll_progress !== undefined) {
        statusLabel.textContent = `LIVE COUNT: ${meta.overall_poll_progress}% REPORTED`;
      } else {
        statusLabel.textContent = meta.status || 'LIVE RESULTS';
      }
    }

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
    setText('kpi-ndp-subtext', `${p['BC NDP']?.net_seat_change_str || '0'} net change vs 2024 (47)`);
    setText('kpi-ndp-pct', `${p['BC NDP']?.vote_share_pct || 0}%`);
    setText('kpi-ndp-votes', (p['BC NDP']?.votes || 0).toLocaleString());

    setText('kpi-con-seats', p['BC Conservative']?.seats || 0);
    setText('kpi-con-subtext', `${p['BC Conservative']?.net_seat_change_str || '0'} net change vs 2024 (44)`);
    setText('kpi-con-pct', `${p['BC Conservative']?.vote_share_pct || 0}%`);
    setText('kpi-con-votes', (p['BC Conservative']?.votes || 0).toLocaleString());

    setText('kpi-grn-seats', p['BC Green']?.seats || 0);
    setText('kpi-grn-subtext', `${p['BC Green']?.net_seat_change_str || '0'} net change vs 2024 (2)`);
    setText('kpi-grn-pct', `${p['BC Green']?.vote_share_pct || 0}%`);
    setText('kpi-grn-votes', (p['BC Green']?.votes || 0).toLocaleString());

    if (meta?.total_boxes_count) {
      setText('kpi-turnout-pct', `${meta.overall_poll_progress}% (${(meta.total_boxes_reported || 0).toLocaleString()} / ${meta.total_boxes_count.toLocaleString()})`);
    } else {
      setText('kpi-turnout-pct', `${meta?.provincial_turnout_pct || 58.45}%`);
    }
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
      const s = r.swing || {};

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
            <span style="color:${s.net_con_swing > 0 ? '#60a5fa' : '#ffaa5c'};font-weight:600;">${s.label || ''}</span>
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
      const s = r.swing || {};
      const net = s.net_con_swing || 0;
      const sign = net > 0 ? '+' : '';

      return `
        <tr>
          <td><span class="riding-table-name" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">${r.name}</span></td>
          <td><span class="party-badge-inline" style="background:rgba(255,255,255,0.06);color:var(--text-muted);">${r.party_2024 || r.prev_party}</span></td>
          <td><span style="color:var(--accent-blue);font-weight:700;">&rarr;</span></td>
          <td><span class="party-badge-inline" style="background:${winnerColor}25;color:${winnerColor};border:1px solid ${winnerColor}50;">${r.winner_party}</span></td>
          <td><strong>${r.winning_candidate}</strong></td>
          <td style="font-family:var(--font-mono);">${r.winner_votes.toLocaleString()} (${r.winner_share}%)</td>
          <td style="font-family:var(--font-mono);color:${r.is_battleground ? 'var(--accent-amber)' : 'inherit'};">+${r.margin_votes.toLocaleString()} (${r.margin_pct}%)</td>
          <td style="font-family:var(--font-mono);color:${net > 0 ? '#60a5fa' : '#ffaa5c'};">${sign}${net.toFixed(1)}%</td>
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
      const s = r.swing || {};
      const net = s.net_con_swing || 0;
      const sign = net > 0 ? '+' : '';

      return `
        <tr>
          <td><span class="riding-table-name" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">${r.name}</span></td>
          <td><span class="party-badge-inline" style="background:${partyColor}25;color:${partyColor};border:1px solid ${partyColor}50;">${r.winner_party}</span></td>
          <td><strong>${r.winning_candidate}</strong></td>
          <td style="font-family:var(--font-mono);">${r.winner_votes.toLocaleString()}</td>
          <td style="font-family:var(--font-mono);">${r.winner_share}%</td>
          <td style="font-family:var(--font-mono);color:${r.is_battleground ? 'var(--accent-amber)' : 'inherit'};">+${r.margin_votes.toLocaleString()}</td>
          <td style="font-family:var(--font-mono);color:${net > 0 ? '#60a5fa' : '#ffaa5c'};">${sign}${net.toFixed(1)}%</td>
          <td>${r.runner_up_candidate ? `${r.runner_up_candidate} (${r.runner_up_party})` : '—'}</td>
          <td style="font-family:var(--font-mono);">${r.status}</td>
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
    if (!electionData?.parties) return;

    const partiesObj = electionData.parties;
    const totalSeats = electionData.metadata?.total_seats || 93;
    const meta = electionData.metadata || {};

    // Get sorted parties list by seats descending, then popular vote
    const partiesList = Object.keys(partiesObj)
      .map(key => ({ key, ...partiesObj[key] }))
      .sort((a, b) => b.seats - a.seats || b.votes - a.votes);

    // 1. Comparison Bars
    const barsContainer = document.getElementById('comparison-bars');
    if (barsContainer) {
      barsContainer.innerHTML = partiesList.map(p => {
        const color = PARTY_COLORS[p.key] || '#8b949e';
        const seatPct = ((p.seats / totalSeats) * 100).toFixed(1);
        const votePct = (p.vote_share_pct || 0).toFixed(1);

        return `
          <div class="comp-party-item">
            <div class="comp-party-header">
              <span style="color:${color};font-weight:700;">${p.name || p.key} (${p.net_seat_change_str || '0'} vs 2024)</span>
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
                  <div class="comp-bar-fill" style="width:${votePct}%; background-color:${PARTY_LIGHT_COLORS[p.key] || color}; opacity:0.85;"></div>
                </div>
                <span class="comp-bar-val">${votePct}%</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    // 2. Gallagher Index (Disproportionality Measure)
    let sumSquares = 0;
    partiesList.forEach(p => {
      const seatPct = (p.seats / totalSeats) * 100;
      const votePct = p.vote_share_pct || 0;
      const diff = votePct - seatPct;
      sumSquares += diff * diff;
    });
    const gallagherIndex = Math.sqrt(0.5 * sumSquares).toFixed(1);
    const gallagherEl = document.getElementById('gallagher-val');
    if (gallagherEl) {
      gallagherEl.textContent = `${gallagherIndex}%`;
    }

    // 3. Dynamic Live Electoral Insights
    const insightsContainer = document.getElementById('analysis-insights-list');
    if (insightsContainer) {
      const topParty = partiesList[0] || {};
      const secondParty = partiesList[1] || {};
      const grnParty = partiesObj['BC Green'] || {};
      const topSeatPct = ((topParty.seats / totalSeats) * 100).toFixed(1);
      const topVotePct = (topParty.vote_share_pct || 0).toFixed(1);
      const topSeatBonus = (topSeatPct - topVotePct).toFixed(1);
      const flipsCount = electionData.summary?.total_flips ?? (electionData.ridings ? electionData.ridings.filter(r => r.is_flip).length : 0);
      const battlegroundsCount = electionData.summary?.total_battlegrounds ?? (electionData.ridings ? electionData.ridings.filter(r => r.is_battleground).length : 0);
      const progress = meta.overall_poll_progress ?? 0;
      const reportedBoxes = (meta.total_boxes_reported || 0).toLocaleString();
      const totalBoxes = (meta.total_boxes_count || 0).toLocaleString();
      const totalVotesCast = (meta.total_votes_cast || 0).toLocaleString();

      const insights = [];

      // Insight 1: Majority / Assembly Status
      if (topParty.seats >= 47) {
        insights.push(`
          <li>
            <strong>${topParty.name || topParty.key} Majority Standing:</strong>
            Currently leading or elected in <strong>${topParty.seats} of 93 seats</strong> (${topSeatPct}% of the assembly), crossing the 47-seat threshold needed for an absolute legislative majority (${topParty.net_seat_change_str} net seats vs. 2024).
          </li>
        `);
      } else {
        insights.push(`
          <li>
            <strong>Minority / Divided Assembly:</strong>
            No single party currently commands the 47 seats required for an outright majority. <strong>${topParty.name || topParty.key}</strong> leads with <strong>${topParty.seats} seats</strong> (${topSeatPct}%), followed by <strong>${secondParty.name || secondParty.key}</strong> with <strong>${secondParty.seats} seats</strong> (${((secondParty.seats / totalSeats) * 100).toFixed(1)}%).
          </li>
        `);
      }

      // Insight 2: Seat Turnover & Flips
      insights.push(`
        <li>
          <strong>Electoral Map Turnover:</strong>
          <strong>${flipsCount} seats</strong> are currently flipping hands compared to the 2024 general election baseline (${topParty.key}: ${topParty.net_seat_change_str}, ${secondParty.key}: ${secondParty.net_seat_change_str}).
        </li>
      `);

      // Insight 3: First-Past-The-Post Vote Efficiency & Seat Bonus
      const bonusSign = topSeatBonus >= 0 ? '+' : '';
      insights.push(`
        <li>
          <strong>First-Past-The-Post Seat Bonus:</strong>
          <strong>${topParty.name || topParty.key}</strong> converted <strong>${topVotePct}% of the provincial popular vote</strong> into <strong>${topSeatPct}% of the seats</strong> (a <strong>${bonusSign}${topSeatBonus}% seat bonus</strong> typical of single-member plurality voting).
        </li>
      `);

      // Insight 4: Third-Party & Independent Representation
      if (grnParty && grnParty.votes) {
        const grnVotesPerSeat = grnParty.seats > 0 ? Math.round(grnParty.votes / grnParty.seats).toLocaleString() : 'N/A';
        insights.push(`
          <li>
            <strong>Third-Party Representation:</strong>
            The BC Green Party garnered <strong>${(grnParty.vote_share_pct || 0).toFixed(1)}% of the popular vote</strong> (${(grnParty.votes || 0).toLocaleString()} votes) across British Columbia, yielding <strong>${grnParty.seats} seats</strong> (an average of <strong>~${grnVotesPerSeat} votes per seat won</strong>).
          </li>
        `);
      }

      // Insight 5: Count Progress & Late Battleground Volatility
      insights.push(`
        <li>
          <strong>Reporting Progress & Volatility:</strong>
          With <strong>${progress}% of ballot boxes reported</strong> (${reportedBoxes} of ${totalBoxes} boxes across 93 ridings, totalling ${totalVotesCast} votes cast), <strong>${battlegroundsCount} ridings</strong> remain razor-thin battlegrounds (margins &lt;3.5%), where late counts may still decide seat allocations.
        </li>
      `);

      insightsContainer.innerHTML = insights.join('');
    }

    // 4. Seat Efficiency Table
    const tableBody = document.getElementById('analysis-efficiency-tbody');
    if (tableBody) {
      tableBody.innerHTML = partiesList.map(p => {
        const color = PARTY_COLORS[p.key] || '#8b949e';
        const seatPct = (p.seats / totalSeats) * 100;
        const votePct = p.vote_share_pct || 0;
        const bias = seatPct - votePct;
        const biasSign = bias >= 0 ? '+' : '';
        const biasColor = bias > 1.0 ? '#4ade80' : (bias < -1.0 ? '#fb923c' : 'var(--text-muted)');
        const votesPerSeat = p.seats > 0 ? Math.round(p.votes / p.seats).toLocaleString() : '—';
        const shiftSign = (p.net_seat_change || 0) > 0 ? '+' : '';
        const shiftColor = (p.net_seat_change || 0) > 0 ? '#60a5fa' : ((p.net_seat_change || 0) < 0 ? '#f87171' : 'var(--text-muted)');

        return `
          <tr>
            <td>
              <span class="party-badge-inline" style="background:${color}22; color:${color}; border:1px solid ${color}55;">
                ${p.name || p.key}
              </span>
            </td>
            <td style="font-family:var(--font-mono); font-weight:700;">${p.seats}</td>
            <td style="font-family:var(--font-mono);">${seatPct.toFixed(1)}%</td>
            <td style="font-family:var(--font-mono);">${(p.votes || 0).toLocaleString()}</td>
            <td style="font-family:var(--font-mono);">${votePct.toFixed(1)}%</td>
            <td style="font-family:var(--font-mono); font-weight:700; color:${biasColor};">${biasSign}${bias.toFixed(1)}%</td>
            <td style="font-family:var(--font-mono); font-weight:700; color:${shiftColor};">${p.net_seat_change_str || `${shiftSign}${p.net_seat_change || 0}`}</td>
            <td style="font-family:var(--font-mono);">${votesPerSeat}</td>
          </tr>
        `;
      }).join('');
    }
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
        const s = r.swing || {};
        return `
          <div class="search-item" onclick="window.selectRiding('${r.name.replace(/'/g, "\\'")}')">
            <div>
              <div style="font-weight:700;">${r.name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);">${r.winning_candidate} (${s.label || ''})</div>
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

  window.selectRiding = function (name) {
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

  document.addEventListener('DOMContentLoaded', init);
})();
