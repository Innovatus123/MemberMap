(function () {
  'use strict';
  var D = JSON.parse(document.getElementById('app-data').textContent);
  if (typeof L === 'undefined' || !L.markerClusterGroup) {
    document.getElementById('map').innerHTML = '<p style="padding:24px;font-size:15px">The map library could not load. ' +
      'This version of the file needs an internet connection. Reconnect and reload the page.</p>';
    return;
  }
  var CFG = D.config;
  // members are stored column-wise to keep the file small
  var MEMBERS = D.members.rows.map(function (r) {
    var o = {};
    D.members.cols.forEach(function (c, i) { o[c] = r[i] === 0 ? D.members.empty[c] : r[i]; });
    return o;
  });
  var CAT = {};
  CFG.categories.forEach(function (c) { CAT[c.key] = c; });
  var RAMP = ['#FBE3E7', '#F4AAB6', '#E8667C', '#CE0E2D', '#8B0000'];

  var state = { q: '', cats: new Set(CFG.categories.map(function (c) { return c.key; })), region: '', tier: '', county: '', view: 'map', sortK: 'company', sortDir: 1 };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function catColor(k) { return (CAT[k] || CAT.Unknown || { color: '#888' }).color; }
  function catLabel(k) { return (CAT[k] || { label: k }).label; }
  function addressLine(m) {
    var a = [m.street, m.suite].filter(Boolean).join(', ');
    var b = [m.city, [m.state, m.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [a, b].filter(Boolean).join(', ');
  }
  function haystack(m) { return (m.company + ' ' + m.contactName + ' ' + m.city + ' ' + m.county).toLowerCase(); }
  MEMBERS.forEach(function (m) { m._h = haystack(m); });

  function matches(m, opts) {
    opts = opts || {};
    if (!state.cats.has(m.category)) return false;
    if (state.region && m.region !== state.region) return false;
    if (state.tier && m.tier !== state.tier) return false;
    if (!opts.ignoreCounty && state.county && m.countyFips !== state.county) return false;
    if (state.q && m._h.indexOf(state.q.toLowerCase()) < 0) return false;
    return true;
  }

  // ---------- map ----------
  var map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(CFG.mapCenter, CFG.mapZoom);
  // Basemap. The file is opened from disk, Box, SharePoint or email, so its tiles must load with
  // no Referer and no API key. CARTO now needs a key and OSM blocks requests without a Referer,
  // so use Esri's light-gray canvas, and switch to the public-domain USGS map if Esri refuses tiles.
  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  var basemap = L.layerGroup([
    L.tileLayer(ESRI + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    }),
    L.tileLayer(ESRI + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }),
  ]).addTo(map);
  var tilesOk = 0, tilesBad = 0;
  basemap.eachLayer(function (l) {
    l.on('tileload', function () { tilesOk++; });
    l.on('tileerror', function () {
      if (++tilesBad < 6 || tilesOk || !map.hasLayer(basemap)) return;
      map.removeLayer(basemap);
      L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 16, attribution: 'Tiles courtesy of the <a href="https://www.usgs.gov/">U.S. Geological Survey</a>',
      }).addTo(map).bringToBack();
    });
  });
  map.setMaxZoom(16);

  L.geoJSON(D.states, { interactive: false, style: { color: '#2D2D2D', weight: 1.6, fill: false, opacity: 0.7 } }).addTo(map);

  var countyCounts = {};
  var countyLayer = L.geoJSON(D.counties, {
    style: countyStyle,
    onEachFeature: function (f, layer) {
      layer.on('mouseover', function () { layer.setStyle({ weight: 2.2, color: '#2D2D2D' }); });
      layer.on('mouseout', function () { countyLayer.resetStyle(layer); });
      layer.on('click', function () { setCounty(state.county === f.id ? '' : f.id); });
      layer.bindTooltip(function () {
        var n = countyCounts[f.id] || 0;
        return '<b>' + esc(f.properties.name) + ' County, ' + esc(f.properties.st) + '</b><br>' + n + ' member' + (n === 1 ? '' : 's');
      }, { sticky: true, className: 'county-tip', direction: 'top' });
    },
  }).addTo(map);

  function bucket(n, max) {
    if (!n) return -1;
    var t = [1, Math.max(2, Math.ceil(max * 0.1)), Math.ceil(max * 0.25), Math.ceil(max * 0.5), Math.ceil(max * 0.8)];
    for (var i = t.length - 1; i >= 0; i--) if (n >= t[i]) return i;
    return 0;
  }
  var countyMax = 0;
  function countyStyle(f) {
    var n = countyCounts[f.id] || 0;
    var b = bucket(n, countyMax);
    var sel = state.county === f.id;
    return {
      color: sel ? '#CE0E2D' : '#8c8c8c', weight: sel ? 3 : 0.7, opacity: 0.9,
      fillColor: b < 0 ? '#ffffff' : RAMP[b], fillOpacity: b < 0 ? 0.05 : 0.55,
    };
  }

  var cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 42, spiderfyOnMaxZoom: true, chunkedLoading: true });
  var markerById = {};
  MEMBERS.forEach(function (m) {
    if (m.lat == null) return;
    var mk = L.circleMarker([m.lat, m.lng], {
      radius: m.category === 'Active' ? 8 : 6.5, color: '#fff', weight: 1.8, fillColor: catColor(m.category), fillOpacity: 0.95,
    });
    mk.bindPopup(function () { return popupHtml(m); }, { maxWidth: 270 });
    mk.on('popupopen', function (e) {
      var more = e.popup.getElement().querySelector('.more');
      if (more) more.addEventListener('click', function () { showDetail(m); });
    });
    mk.member = m;
    markerById[m.id] = mk;
  });
  map.addLayer(cluster);

  function precisionNote(m) {
    if (m.precision === 'street') return '';
    if (m.precision === 'zip') return '<div class="approx">Approximate location: ZIP code centre' + (m.poBox ? ' (PO box on file - street address needed)' : '') + '.</div>';
    if (m.precision === 'city') return '<div class="approx">Approximate location: city centre (address needs review).</div>';
    return '<div class="approx">Not on the map - no usable address on file.</div>';
  }
  function chipsHtml(m) {
    var h = '<div class="chips"><span class="chip" style="background:' + catColor(m.category) + '">' + esc(m.category === 'Unknown' ? 'Type not on file' : m.category) + '</span>';
    if (m.region) h += '<span class="chip soft">' + esc(m.region) + '</span>';
    return h + '</div>';
  }
  function popupHtml(m) {
    return '<div class="pop"><h3>' + esc(m.company) + '</h3>' + chipsHtml(m) +
      '<div class="addr">' + esc(addressLine(m)) + '</div>' +
      (m.contactName ? '<div>' + esc(m.contactName) + '</div>' : '') +
      precisionNote(m) + '<span class="more" role="button" tabindex="0">Full record \u203A</span></div>';
  }

  // ---------- detail ----------
  function kv(k, v) { return v ? '<div class="kv"><span class="k">' + esc(k) + '</span><span>' + v + '</span></div>' : ''; }
  function showDetail(m) {
    var dir = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addressLine(m));
    var h = '<h2>' + esc(m.company) + '</h2>' + chipsHtml(m);
    h += '<div class="sec"><h4>Membership</h4>' + kv('Type', esc(catLabel(m.category))) +
      (CFG.publish.showDuesTier ? kv('Dues tier', esc(m.tier)) : '') + kv('Since', esc(m.memberSince)) + '</div>';
    h += '<div class="sec"><h4>Location</h4>' + kv('Address', esc(addressLine(m)) || '<span class="muted">None on file</span>') +
      kv('County', m.county ? esc(m.county + ' County') : '') + kv('Region', esc(m.region)) +
      (m.street || m.city ? kv('Directions', '<a href="' + esc(dir) + '" target="_blank" rel="noopener">Open in Google Maps</a>') : '') +
      precisionNote(m) + '</div>';
    var contact = '';
    if (CFG.publish.showPrimaryContact) contact += kv('Primary', esc(m.contactName));
    if (CFG.publish.showEmail && m.email) contact += kv('Email', '<a href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a>');
    if (m.phone) contact += kv('Phone', '<a href="tel:' + esc(m.phone.replace(/[^\d+]/g, '')) + '">' + esc(m.phone) + '</a>');
    if (m.website) contact += kv('Website', '<a href="' + esc(m.website) + '" target="_blank" rel="noopener">' + esc(m.website.replace(/^https?:\/\//, '')) + '</a>');
    if (contact) h += '<div class="sec"><h4>Contact</h4>' + contact + '</div>';
    $('detail-body').innerHTML = h;
    $('detail').hidden = false;
    if (m.lat != null && state.view === 'map') focusMarker(m);
  }
  $('detail-close').addEventListener('click', function () { $('detail').hidden = true; });

  var ring = null;
  function focusMarker(m) {
    var mk = markerById[m.id];
    if (!mk) return;
    cluster.zoomToShowLayer(mk, function () {
      if (ring) map.removeLayer(ring);
      ring = L.marker(mk.getLatLng(), { icon: L.divIcon({ className: '', html: '<div class="hl-ring"></div>', iconSize: [0, 0] }), interactive: false }).addTo(map);
    });
  }

  // ---------- sidebar controls ----------
  var catBox = $('cats');
  CFG.categories.forEach(function (c) {
    if (!MEMBERS.some(function (m) { return m.category === c.key; })) return;
    var lab = document.createElement('label');
    lab.className = 'toggle';
    lab.innerHTML = '<input type="checkbox" checked data-cat="' + esc(c.key) + '"><span class="swatch" style="background:' + c.color + '"></span>' +
      esc(c.label) + '<span class="cnt" data-cnt="' + esc(c.key) + '">0</span>';
    catBox.appendChild(lab);
  });
  catBox.addEventListener('change', function (e) {
    var k = e.target.getAttribute('data-cat');
    if (!k) return;
    if (e.target.checked) state.cats.add(k); else state.cats.delete(k);
    render();
  });

  var regionNames = CFG.regions.map(function (r) { return r.name; }).concat(['Not mapped'])
    .filter(function (r) { return MEMBERS.some(function (m) { return m.region === r; }); });
  regionNames.forEach(function (r) { $('region').insertAdjacentHTML('beforeend', '<option>' + esc(r) + '</option>'); });
  $('region').addEventListener('change', function (e) { state.region = e.target.value; render(true); });

  if (CFG.publish.showDuesTier) {
    D.tiers.forEach(function (t) { $('tier').insertAdjacentHTML('beforeend', '<option>' + esc(t) + '</option>'); });
    $('tier').addEventListener('change', function (e) { state.tier = e.target.value; render(); });
  } else {
    $('tier-field').hidden = true;
    $('list-table').querySelector('[data-k="tier"]').hidden = true;
  }

  $('lyr-markers').addEventListener('change', function (e) { if (e.target.checked) map.addLayer(cluster); else map.removeLayer(cluster); });
  $('lyr-counties').addEventListener('change', function (e) { if (e.target.checked) countyLayer.addTo(map); else map.removeLayer(countyLayer); });

  function setCounty(fips) { state.county = fips; render(true); }

  // search with autocomplete
  var q = $('q'), results = $('results'), activeIdx = -1;
  q.addEventListener('input', function () { state.q = q.value.trim(); render(); showResults(); });
  q.addEventListener('focus', showResults);
  q.addEventListener('keydown', function (e) {
    var btns = results.querySelectorAll('button');
    if (e.key === 'ArrowDown') { activeIdx = Math.min(btns.length - 1, activeIdx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { activeIdx = Math.max(0, activeIdx - 1); e.preventDefault(); }
    else if (e.key === 'Enter' && btns[activeIdx > -1 ? activeIdx : 0]) { btns[activeIdx > -1 ? activeIdx : 0].click(); e.preventDefault(); return; }
    else if (e.key === 'Escape') { results.hidden = true; return; }
    btns.forEach(function (b, i) { b.classList.toggle('active', i === activeIdx); });
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search-field')) results.hidden = true; });
  function showResults() {
    activeIdx = -1;
    if (!state.q) { results.hidden = true; return; }
    var hits = MEMBERS.filter(function (m) { return matches(m); }).slice(0, 12);
    results.innerHTML = hits.length ? hits.map(function (m) {
      return '<button data-id="' + esc(m.id) + '">' + esc(m.company) + '<div class="rc">' + esc([m.category, m.city, m.state].filter(Boolean).join(' \u00B7 ')) + '</div></button>';
    }).join('') : '<div class="none">No members match.</div>';
    results.hidden = false;
  }
  results.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var m = MEMBERS.find(function (x) { return x.id === b.getAttribute('data-id'); });
    results.hidden = true;
    if (m) showDetail(m);
  });

  // view toggle
  document.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.getAttribute('data-view');
      document.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
      $('list').hidden = state.view !== 'list';
      if (state.view === 'map') setTimeout(function () { map.invalidateSize(); }, 0);
    });
  });

  // list sorting
  $('list-table').querySelector('thead').addEventListener('click', function (e) {
    var k = e.target.getAttribute('data-k');
    if (!k) return;
    state.sortDir = state.sortK === k ? -state.sortDir : 1;
    state.sortK = k;
    renderList(MEMBERS.filter(function (m) { return matches(m); }));
  });
  $('list-table').querySelector('tbody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    var m = MEMBERS.find(function (x) { return x.id === tr.getAttribute('data-id'); });
    if (m) showDetail(m);
  });

  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-reset').addEventListener('click', function () {
    state.q = ''; q.value = ''; state.region = ''; $('region').value = ''; state.tier = ''; $('tier').value = ''; state.county = '';
    state.cats = new Set(CFG.categories.map(function (c) { return c.key; }));
    catBox.querySelectorAll('input').forEach(function (i) { i.checked = true; });
    $('detail').hidden = true;
    map.setView(CFG.mapCenter, CFG.mapZoom);
    render();
  });
  $('btn-export').addEventListener('click', function () {
    var cols = ['company', 'category', 'tier', 'region', 'county', 'street', 'suite', 'city', 'state', 'zip', 'contactName', 'email', 'phone', 'website', 'precision'];
    if (!CFG.publish.showDuesTier) cols.splice(cols.indexOf('tier'), 1);
    var rows = MEMBERS.filter(function (m) { return matches(m); });
    var csv = [cols.join(',')].concat(rows.map(function (m) {
      return cols.map(function (c) { var v = String(m[c] == null ? '' : m[c]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    })).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'gbca-members-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  // ---------- render ----------
  function renderList(rows) {
    var k = state.sortK, dir = state.sortDir;
    rows = rows.slice().sort(function (a, b) {
      if (k === 'tier') return (D.tierRank[a.tier] - D.tierRank[b.tier]) * dir;
      return String(a[k] || '~').localeCompare(String(b[k] || '~')) * dir;
    });
    $('list-count').textContent = rows.length;
    var showTier = CFG.publish.showDuesTier;
    $('list-table').querySelector('tbody').innerHTML = rows.map(function (m) {
      return '<tr data-id="' + esc(m.id) + '"><td><b>' + esc(m.company) + '</b></td>' +
        '<td><span class="dot" style="background:' + catColor(m.category) + '"></span>' + esc(m.category) + '</td>' +
        (showTier ? '<td>' + esc(m.tier) + '</td>' : '') +
        '<td>' + esc(m.region) + '</td><td>' + esc(m.county) + '</td><td>' + esc(m.city) + (m.state ? ', ' + esc(m.state) : '') + '</td>' +
        '<td>' + esc(m.contactName) + '</td></tr>';
    }).join('');
  }

  function renderSummary(rows) {
    var cats = CFG.categories.filter(function (c) { return MEMBERS.some(function (m) { return m.category === c.key; }); });
    var head = '<thead><tr><th>Region</th>' + cats.map(function (c) { return '<th title="' + esc(c.label) + '">' + esc(c.key.slice(0, 3)) + '</th>'; }).join('') + '<th>All</th></tr></thead>';
    var body = regionNames.map(function (r) {
      var inR = rows.filter(function (m) { return m.region === r; });
      if (!inR.length) return '';
      return '<tr data-region="' + esc(r) + '"><td>' + esc(r) + '</td>' + cats.map(function (c) {
        return '<td>' + (inR.filter(function (m) { return m.category === c.key; }).length || '') + '</td>';
      }).join('') + '<td><b>' + inR.length + '</b></td></tr>';
    }).join('');
    var total = '<tr class="total"><td>Total</td>' + cats.map(function (c) {
      return '<td>' + rows.filter(function (m) { return m.category === c.key; }).length + '</td>';
    }).join('') + '<td>' + rows.length + '</td></tr>';
    $('summary').innerHTML = head + '<tbody>' + body + '</tbody><tfoot>' + total + '</tfoot>';
  }
  $('summary').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-region]');
    if (!tr) return;
    var r = tr.getAttribute('data-region');
    state.region = state.region === r ? '' : r;
    $('region').value = state.region;
    render(true);
  });

  function renderActiveFilters() {
    var box = $('active-filters');
    if (!state.county) { box.innerHTML = ''; return; }
    var f = D.counties.features.find(function (x) { return x.id === state.county; });
    box.innerHTML = '<div class="active-filter">County: <b>' + esc(f ? f.properties.name + ', ' + f.properties.st : state.county) + '</b><button aria-label="Clear county filter">\u00D7</button></div>';
    box.querySelector('button').addEventListener('click', function () { setCounty(''); });
  }

  function render(fit) {
    var shown = MEMBERS.filter(function (m) { return matches(m); });

    // county shading ignores the county filter so the selected county stays in context
    countyCounts = {};
    MEMBERS.forEach(function (m) { if (m.countyFips && matches(m, { ignoreCounty: true })) countyCounts[m.countyFips] = (countyCounts[m.countyFips] || 0) + 1; });
    var footprint = {};
    D.counties.features.forEach(function (f) { footprint[f.id] = f; });
    countyMax = 0;
    Object.keys(countyCounts).forEach(function (k) { if (footprint[k]) countyMax = Math.max(countyMax, countyCounts[k]); });
    countyLayer.setStyle(countyStyle);

    cluster.clearLayers();
    var layers = [];
    shown.forEach(function (m) { if (markerById[m.id]) layers.push(markerById[m.id]); });
    cluster.addLayers(layers);

    // stats
    $('st-members').textContent = MEMBERS.length;
    $('st-shown').textContent = shown.length;
    $('st-mapped').textContent = layers.length;
    var shownCounties = {};
    shown.forEach(function (m) { if (m.countyFips) shownCounties[m.countyFips] = (shownCounties[m.countyFips] || 0) + 1; });
    $('st-counties').textContent = Object.keys(shownCounties).length;
    var top = Object.keys(shownCounties).sort(function (a, b) { return shownCounties[b] - shownCounties[a]; })[0];
    var topName = top && (MEMBERS.find(function (m) { return m.countyFips === top; }) || {}).county;
    $('st-top').textContent = topName ? topName + ' (' + shownCounties[top] + ')' : '-';

    CFG.categories.forEach(function (c) {
      var el = catBox.querySelector('[data-cnt="' + c.key + '"]');
      if (el) el.textContent = MEMBERS.filter(function (m) {
        return m.category === c.key && (!state.region || m.region === state.region) && (!state.tier || m.tier === state.tier) &&
          (!state.county || m.countyFips === state.county) && (!state.q || m._h.indexOf(state.q.toLowerCase()) >= 0);
      }).length;
    });

    $('ramp').innerHTML = RAMP.map(function (c) { return '<span style="background:' + c + '"></span>'; }).join('');
    $('ramp-max').textContent = countyMax;
    renderSummary(shown);
    renderActiveFilters();
    renderList(shown);

    if (fit && layers.length && state.view === 'map') {
      map.fitBounds(L.featureGroup(layers).getBounds().pad(0.15), { maxZoom: 13 });
    }
  }

  render();
})();
