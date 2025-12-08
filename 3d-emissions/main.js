// main.js — ES module version

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as d3 from "d3";

console.log("main.js loaded; typeof THREE =", typeof THREE);

const DATA_FILE = "GHG_totals_by_country.csv";
const MAX_BARS = 18;

// Color palette: similar to the 2D chart (US still special)
const countryColorScale = d3
  .scaleOrdinal(d3.schemeTableau10);

let isPlaying = false;
let playTimer = null;


// NEW: sector breakdown data
const SECTOR_FILE = "GHG_by_sector_and_country.csv";
const SECTOR_ORDER = [
  "Power Industry",
  "Industrial Combustion",
  "Buildings",
  "Transport",
  "Fuel Exploitation",
  "Agriculture",
  "Processes",
  "Waste",
];

const TRANSITION_SPEED = 0.18;
const CAMERA_DISTANCE = 25;

const COLOR_US = new THREE.Color(0xf5c04f);
const COLOR_OTHER = new THREE.Color(0x4f8df5);
const COLOR_OTHER_DIM = new THREE.Color(0x243b73);

const container = document.getElementById("scene-container");
const slider = document.getElementById("year-slider");
const yearLabel = document.getElementById("year-value");

const tooltip = document.getElementById("tooltip");
const tooltipCountry = document.getElementById("tooltip-country");
const tooltipYear = document.getElementById("tooltip-year");
const tooltipEmissions = document.getElementById("tooltip-emissions");
const tooltipShare = document.getElementById("tooltip-share");
const tooltipRank = document.getElementById("tooltip-rank");
const globalTotalEl = document.getElementById("global-total-value");

// Detail panel elements
const sectorTitleEl = document.getElementById("sector-title");
const sectorSubtitleEl = document.getElementById("sector-subtitle");
const sectorYearPillEl = document.getElementById("sector-year-pill");

// Sidebar metrics list (numbers per sector)
const metricsListEl = document.getElementById("sector-metrics-list");

function updateSectorMetrics(sectors) {
  if (!metricsListEl || !sectors) return;

  // Clear previous rows
  metricsListEl.innerHTML = "";

  sectors.forEach((s) => {
    const row = document.createElement("div");
    row.className = "sector-metric-row";

    const label = document.createElement("span");
    label.className = "sector-metric-label";

    const dot = document.createElement("span");
    dot.className = "sector-metric-dot";
    // use provided color if present, else fall back to scale
    dot.style.backgroundColor = s.color || sectorColorScale(s.name);

    const name = document.createElement("span");
    name.textContent = s.name;

    label.appendChild(dot);
    label.appendChild(name);

    const value = document.createElement("span");
    value.className = "sector-metric-value";
    value.textContent = `${s.value.toLocaleString("en-US", {
      maximumFractionDigits: 1,
    })} MtCO₂e`;

    row.appendChild(label);
    row.appendChild(value);
    metricsListEl.appendChild(row);
  });
}

// Radar-chart state
let sectorDataByKey = {}; // key = `${iso}_${year}` -> { sectors: {...} }

let sectorSvg = null;
let sectorG = null;
let radarPath = null;
let radarPointsGroup = null;
let radarAngleScale = null;
let radarRadius = 0;
let selectedCountry = null;  // { iso, country }
let currentYear = null;

const sectorColorScale = d3
  .scaleOrdinal()
  .domain(SECTOR_ORDER)
  .range([
    "#60a5fa",
    "#34d399",
    "#f97316",
    "#facc15",
    "#a855f7",
    "#2dd4bf",
    "#f472b6",
    "#22c55e",
  ]);

// --- Country label sprites (vertical text) -----------------------
function createCountryLabel(text) {
  const canvas = document.createElement("canvas");
  const size = 256;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Background transparent
  ctx.clearRect(0, 0, size, size);

  // Draw text in the middle, but rotate so it reads vertically
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-Math.PI / 2); // vertical orientation
  ctx.font = "42px system-ui, -apple-system, BlinkMacSystemFont";
  ctx.fillStyle = "#e5e7eb";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0);
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
  });

  const sprite = new THREE.Sprite(material);
  // Narrow/tall so it sits nicely above each bar
  sprite.scale.set(2.2, 2.2, 1);

  return sprite;
}

let scene, camera, renderer, controls;
let bars = [];
let barGroup;
let floorGrid;
let animationId;
let barLabels = []; // DOM labels anchored to each bar

const playButton = document.getElementById("play-button");

let emissionsByYear = {};
let totalsByYear = {};
let years = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredBar = null;
let selectedBar = null; // NEW: persists after click

// ----------------- init scene -----------------

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050b1f);
  scene.fog = new THREE.FogExp2(0x050b1f, 0.015); // lighter, weaker fog

  const aspect = container.clientWidth / container.clientHeight;
  camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 200);
  camera.position.set(0, 9, CAMERA_DISTANCE); 
  camera.lookAt(0, 6, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMappingExposure = 1.4;      // bump exposure a bit
  container.appendChild(renderer.domElement);

  // OrbitControls is imported in your ES-module version
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 7, 0);
  controls.update();   

  // === MUCH BRIGHTER LIGHTING ===
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x050816, 0.9);
  scene.add(hemi);

  const dir1 = new THREE.DirectionalLight(0xffffff, 1.4);
  dir1.position.set(18, 30, 12);
  scene.add(dir1);

  const dir2 = new THREE.DirectionalLight(0x88b0ff, 0.8);
  dir2.position.set(-16, 18, -10);
  scene.add(dir2);

  // Floor
  const planeGeo = new THREE.PlaneGeometry(60, 40);
  const planeMat = new THREE.MeshStandardMaterial({
    color: 0x0b1120,      // slightly lighter than before
    metalness: 0.15,
    roughness: 0.9,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0;
  scene.add(plane);

  // Grid
  const grid = new THREE.GridHelper(60, 30, 0x1f2937, 0x111827);
  grid.position.y = 0.01;
  scene.add(grid);
  floorGrid = grid;

  // Arc
  const arcGeom = new THREE.TorusGeometry(18, 0.08, 12, 100, Math.PI);
  const arcMat = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0.55,        // brighter arc
  });
  const arc = new THREE.Mesh(arcGeom, arcMat);
  arc.rotation.x = Math.PI / 2;
  arc.position.set(0, 0.02, -6);
  scene.add(arc);

  barGroup = new THREE.Group();
  scene.add(barGroup);

  window.addEventListener("resize", onWindowResize);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  renderer.domElement.addEventListener("click", onPointerClick); // NEW

  // Listen on the whole scene container so overlays / padding don’t break hover
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerleave", onPointerLeave);
}

function onWindowResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ----------------- data loading -----------------

function loadData() {
  // Load BOTH the totals file and the sector-breakdown file
  Promise.all([d3.csv(DATA_FILE), d3.csv(SECTOR_FILE)])
    .then(([rows, sectorRows]) => {
      if (!rows || !rows.length) {
        console.error("No data loaded from", DATA_FILE);
        return;
      }

      // Use the year columns from the totals file (they match the sector file)
      const yearCols = rows.columns.filter((c) => /^\d{4}$/.test(c));
      years = yearCols.map((d) => +d).sort((a, b) => a - b);

      // ----------- 3D bar data (top emitters, NO GLOBAL TOTAL bar) -----------
      yearCols.forEach((col) => {
        const year = +col;
        let list = [];
        let globalTotalForYear = null;

        rows.forEach((row) => {
          const raw = row[col];
          if (raw === undefined || raw === null || raw === "") return;

          const val = +raw;
          if (isNaN(val) || val <= 0) return;

          const isGlobal =
            row["Country"] === "GLOBAL TOTAL" ||
            row["EDGAR Country Code"] === "GLOBAL TOTAL";

          if (isGlobal) {
            // Only used for the sidebar total + percentages
            globalTotalForYear = val;
          } else {
            // Normal country row → candidate for 3D bars
            list.push({
              country: row["Country"],
              iso: row["EDGAR Country Code"],
              value: val,
            });
          }
        });

        // Sort countries by emissions (descending)
        list.sort((a, b) => b.value - a.value);

        // Fallback: if the dataset had no GLOBAL TOTAL row, sum the countries
        if (globalTotalForYear == null) {
          globalTotalForYear = list.reduce((acc, d) => acc + d.value, 0);
        }

        emissionsByYear[year] = list;
        totalsByYear[year] = globalTotalForYear;
      });

      // ----------- Sector breakdown data (for the radar chart) -----------
      sectorDataByKey = {}; // reset in case of reload

      if (sectorRows && sectorRows.length) {
        sectorRows.forEach((row) => {
          const iso = row["EDGAR Country Code"];
          const country = row["Country"];
          const sectorName = row["Sector"];

          yearCols.forEach((col) => {
            const raw = row[col];
            if (raw === undefined || raw === null || raw === "") return;
            const val = +raw;
            if (isNaN(val) || val <= 0) return;

            const year = +col;
            const key = `${iso}_${year}`;

            if (!sectorDataByKey[key]) {
              sectorDataByKey[key] = {
                iso,
                country,
                year,
                sectors: {},
              };
            }

            const entry = sectorDataByKey[key];
            entry.sectors[sectorName] =
              (entry.sectors[sectorName] || 0) + val;
          });
        });
      }

      // ----------- Boot the UI once all data is ready -----------
      initYearSlider();
      const initialYear = years[years.length - 1];
      buildBarsForYear(initialYear);
      updateGlobalTotalDisplay(initialYear);
      startAnimationLoop();
    })
    .catch((err) => {
      console.error("Error loading CSV files", err);
    });
}

function formatNumber(value) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

function updateGlobalTotalDisplay(year) {
  if (!globalTotalEl) return;
  const total = totalsByYear[year];
  if (total == null || !isFinite(total)) {
    globalTotalEl.textContent = "—";
  } else {
    globalTotalEl.textContent = `${formatNumber(total)} MtCO₂e`;
  }
}

// ----------------- slider -----------------

function initYearSlider() {
  slider.min = 0;
  slider.max = years.length - 1;
  slider.value = years.length - 1;
  yearLabel.textContent = years[years.length - 1];

  slider.addEventListener("input", () => {
    stopAutoPlay(); // stop race when the user scrubs
    const idx = +slider.value;
    const year = years[idx];
    yearLabel.textContent = year;
    updateBarsForYear(year);
  });

  if (playButton) {
    playButton.addEventListener("click", () => {
      if (isPlaying) {
        stopAutoPlay();
      } else {
        startAutoPlay();
      }
    });
  }
}

function startAutoPlay() {
  if (isPlaying) return;
  isPlaying = true;
  if (playButton) playButton.classList.add("playing");
  if (playButton) playButton.textContent = "PAUSE";

  const step = () => {
    if (!isPlaying) return;

    let idx = +slider.value;
    if (idx >= years.length - 1) {
      idx = 0; // loop back to start
    } else {
      idx += 1;
    }

    slider.value = idx;
    const year = years[idx];
    yearLabel.textContent = year;
    updateBarsForYear(year);

    playTimer = setTimeout(step, 350); 
  };

  step();
}

function stopAutoPlay() {
  if (!isPlaying) return;
  isPlaying = false;
  if (playTimer) {
    clearTimeout(playTimer);
    playTimer = null;
  }
  if (playButton) {
    playButton.classList.remove("playing");
    playButton.textContent = "PLAY";
  }
}


// ----------------- bars -----------------

function buildBarsForYear(year) {
  currentYear = year;        
  // remove meshes
  while (barGroup.children.length) barGroup.remove(barGroup.children[0]);

  // remove old DOM labels
  barLabels.forEach((el) => el.remove());
  barLabels = [];
  bars = [];

  const data = emissionsByYear[year].slice(0, MAX_BARS);
  const maxVal = data[0].value;
  const globalTotal = totalsByYear[year];

  const spacing = 2;
  const totalWidth = (data.length - 1) * spacing;
  const offsetX = -totalWidth / 2;

  data.forEach((d, i) => {
    const normH = d.value / maxVal;
    const h = normH * 14 + 0.2;

    const isUS =
      d.country === "United States of America" ||
      d.country === "United States" ||
      d.iso === "USA";

    // base color per country (US is golden)
    let baseHex;
    if (isUS) {
      baseHex = "#f5c04f";
    } else {
      baseHex = d3.color(countryColorScale(d.country)).formatHex();
    }
    const baseColor = new THREE.Color(baseHex);
    const emissiveColor = isUS
      ? new THREE.Color(0x4b2600)
      : baseColor.clone().multiplyScalar(0.35);

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      emissive: emissiveColor,
      emissiveIntensity: isUS ? 0.9 : 0.7,
      roughness: 0.35,
      metalness: 0.3,
    });

    const mesh = new THREE.Mesh(geom, mat);
    const x = offsetX + i * spacing;

    mesh.position.set(x, h / 2 + 0.02, 0);
    mesh.scale.set(0.8, h, 0.8);

    mesh.userData = {
      country: d.country,
      iso: d.iso,
      value: d.value,
      year,
      rank: i + 1,
      globalTotal,
      targetHeight: h,
      targetX: x,
      isUS,
      baseColor,
      emissiveColor,
      baseEmissiveIntensity: isUS ? 0.9 : 0.7,
    };

    barGroup.add(mesh);

    // DOM label
    const labelEl = document.createElement("div");
    labelEl.className = "bar-label";
    labelEl.textContent = d.iso || d.country;
    container.appendChild(labelEl);

    bars.push({ mesh, labelEl });
    barLabels.push(labelEl);
  });

  syncSelectionForYear(year);
}

function updateBarsForYear(year) {
  currentYear = year;               // NEW
  const data = emissionsByYear[year].slice(0, MAX_BARS);
  const maxVal = data[0].value;
  const globalTotal = totalsByYear[year];
  
  updateGlobalTotalDisplay(year); // NEW

  // if count changes, just rebuild
  if (data.length !== bars.length) {
    buildBarsForYear(year);
    return;
  }

  const spacing = 2.2;
  const totalWidth = (data.length - 1) * spacing;
  const offsetX = -totalWidth / 2;

  data.forEach((d, i) => {
    const barObj = bars[i];
    const mesh = barObj.mesh;

    const normH = d.value / maxVal;
    const h = normH * 14 + 0.2;

    const isUS =
      d.country === "United States of America" ||
      d.country === "United States" ||
      d.iso === "USA";

    let baseHex;
    if (isUS) {
      baseHex = "#f5c04f";
    } else {
      baseHex = d3.color(countryColorScale(d.country)).formatHex();
    }
    const baseColor = new THREE.Color(baseHex);
    const emissiveColor = isUS
      ? new THREE.Color(0x4b2600)
      : baseColor.clone().multiplyScalar(0.35);

    const ud = mesh.userData;
    Object.assign(ud, {
      country: d.country,
      iso: d.iso,
      value: d.value,
      year,
      rank: i + 1,
      globalTotal,
      targetHeight: h,
      targetX: offsetX + i * spacing,
      isUS,
      baseColor,
      emissiveColor,
      baseEmissiveIntensity: isUS ? 0.9 : 0.7,
    });

    const mat = mesh.material;
    mat.color.copy(baseColor);
    mat.emissive.copy(emissiveColor);
    mat.emissiveIntensity = ud.baseEmissiveIntensity;

    // update label text if the rank's country changed
    if (barObj.labelEl) {
  barObj.labelEl.textContent = d.iso || d.country;
}
  });

  syncSelectionForYear(year);
}

// ----------------- animation -----------------

function startAnimationLoop() {
  if (animationId) cancelAnimationFrame(animationId);
  const baseTime = performance.now();

  function animate(now) {
    animationId = requestAnimationFrame(animate);
    const t = (now - baseTime) * 0.0002;

    if (floorGrid) {
      const scale = 1 + Math.sin(t * 2) * 0.015;
      floorGrid.scale.set(scale, 1, scale);
    }

        bars.forEach(({ mesh, labelEl }) => {
      const ud = mesh.userData;

      // height easing
      const currentH = mesh.scale.y;
      const targetH = ud.targetHeight;
      mesh.scale.y = currentH + (targetH - currentH) * TRANSITION_SPEED;
      mesh.position.y = mesh.scale.y / 2 + 0.02;

      // x-position easing for bar race feel
      if (typeof ud.targetX === "number") {
        mesh.position.x =
          mesh.position.x +
          (ud.targetX - mesh.position.x) * TRANSITION_SPEED;
      }

      // tiny z wiggle for depth feel
      const phase = (ud.rank || 0) * 0.6;
      mesh.position.z = Math.sin(t * 1.8 + phase) * 0.03;

      // update screen-space label position
      if (labelEl) {
        const topWorld = new THREE.Vector3(
          mesh.position.x,
          mesh.position.y + mesh.scale.y / 2 + 0.4,
          mesh.position.z
        );

        topWorld.project(camera);
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const x = (topWorld.x * 0.5 + 0.5) * cw;
        const y = (-topWorld.y * 0.5 + 0.5) * ch;

        labelEl.style.left = `${x}px`;
        labelEl.style.top = `${y}px`;
        labelEl.style.opacity = topWorld.z < 1 ? 1 : 0;
      }
    });

    controls.update();
    renderer.render(scene, camera);
  }

  animate(baseTime);
}

// ----------------- interaction -----------------

function onPointerMove(event) {
  if (!barGroup) return;

  // Get pointer position relative to the scene container
  const bounds = container.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);

  // Intersect with ALL descendants in the bar group (bars + labels, etc.)
  const hits = raycaster.intersectObjects(barGroup.children, true);

  // Find the first hit that actually corresponds to a bar (has userData.country)
  const barHit = hits.find(
    (h) => h.object && h.object.userData && h.object.userData.country
  );

  if (barHit) {
    const mesh = barHit.object;
    if (hoveredBar !== mesh) {
      clearHoveredBar();
      setHoveredBar(mesh);
    }
    positionTooltip(event.clientX, event.clientY, mesh.userData);
  } else {
    clearHoveredBar();
    hideTooltip();
  }
}

function onPointerLeave() {
  clearHoveredBar();
  hideTooltip();
}

function onPointerClick(event) {
  const bounds = container.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(barGroup.children, true);

  const barHit = hits.find(
    (h) => h.object && h.object.userData && h.object.userData.country
  );
  if (!barHit) return;

  const mesh = barHit.object;
  selectBar(mesh);

  const ud = mesh.userData;
  if (ud && ud.iso) {
    // remember this selection
    selectedCountry = {
      iso: ud.iso,
      country: ud.country,
    };

    // use the global currentYear (should match ud.year)
    const year = currentYear != null ? currentYear : ud.year;
    updateSectorFromKey(selectedCountry.iso, year, selectedCountry.country);
  }
}

function setHoveredBar(mesh) {
  hoveredBar = mesh;
  const ud = hoveredBar.userData;
  const mat = hoveredBar.material;

  const highlightColor = ud.baseColor.clone().lerp(new THREE.Color(0xffffff), 0.15);
  mat.color.copy(highlightColor);
  mat.emissiveIntensity = ud.baseEmissiveIntensity + 0.2;
}

function resetBarMaterial(mesh) {
  if (!mesh) return;
  const ud = mesh.userData;
  const mat = mesh.material;
  if (!ud || !mat) return;

  mat.color.copy(ud.baseColor);
  mat.emissive.copy(ud.emissiveColor);
  mat.emissiveIntensity = ud.baseEmissiveIntensity;
}

function syncSelectionForYear(year) {
  if (!selectedCountry) return;

  // Find the mesh for the selected country in the current bar set (if visible)
  let foundMesh = null;
  bars.forEach(({ mesh }) => {
    const ud = mesh.userData;
    if (ud && ud.iso === selectedCountry.iso) {
      foundMesh = mesh;
    }
  });

  if (foundMesh) {
    // Highlight that bar
    selectBar(foundMesh);
  } else if (selectedBar) {
    // Country is no longer in the top MAX_BARS this year – clear bar highlight
    resetBarMaterial(selectedBar);
    selectedBar = null;
  }

  // Always update the radar, even if the country’s bar is no longer in top N
  updateSectorFromKey(selectedCountry.iso, year, selectedCountry.country);
}

function clearHoveredBar() {
  if (!hoveredBar) return;
  if (hoveredBar !== selectedBar) {
    resetBarMaterial(hoveredBar);
  }
  hoveredBar = null;
}

function selectBar(mesh) {
  if (selectedBar && selectedBar !== mesh) {
    resetBarMaterial(selectedBar);
  }
  selectedBar = mesh;
  const mat = selectedBar.material;
  mat.emissiveIntensity += 0.2;
}

function positionTooltip(x, y, data) {
  if (!data) return;
  tooltip.style.display = "block";

  const share =
    data.globalTotal > 0 ? ((data.value / data.globalTotal) * 100).toFixed(1) : 0;

  tooltipCountry.textContent = data.country;
  tooltipYear.textContent = `Year: ${data.year}`;
  tooltipEmissions.textContent = data.value.toFixed(1);
  tooltipShare.textContent = share;
  tooltipRank.textContent = `#${data.rank} emitter`;

  const padding = 12;
  const rect = tooltip.getBoundingClientRect();
  let left = x + padding;
  let top = y + padding;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (left + rect.width + padding > vw) left = x - rect.width - padding;
  if (top + rect.height + padding > vh) top = y - rect.height - padding;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.style.display = "none";
}

// ----------------- sector radar visualization -----------------

function initSectorViz() {
  const container = d3.select("#sector-viz-container");
  const node = container.node();
  if (!node) return;

  const width = node.clientWidth || 360;
  const height = 260;
  radarRadius = Math.min(width, height) / 2 - 26;

  sectorSvg = container
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  sectorG = sectorSvg
    .append("g")
    .attr("transform", `translate(${width / 2}, ${height / 2})`);

  radarAngleScale = d3
    .scaleLinear()
    .domain([0, SECTOR_ORDER.length])
    .range([0, 2 * Math.PI]);

  // Concentric grid circles
  const gridLevels = [0.25, 0.5, 0.75, 1];
  const gridGroup = sectorG.append("g").attr("class", "radar-grid");
  gridLevels.forEach((level) => {
    gridGroup
      .append("circle")
      .attr("class", "radar-grid-circle")
      .attr("r", radarRadius * level);
  });

  // Axes + labels
  const axesGroup = sectorG.append("g").attr("class", "radar-axes");
  const labelRadius = radarRadius + 14;

  SECTOR_ORDER.forEach((name, i) => {
    const angle = radarAngleScale(i) - Math.PI / 2;
    const x = Math.cos(angle) * radarRadius;
    const y = Math.sin(angle) * radarRadius;

    axesGroup
      .append("line")
      .attr("class", "radar-axis-line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", x)
      .attr("y2", y);

    const lx = Math.cos(angle) * labelRadius;
    const ly = Math.sin(angle) * labelRadius;

    axesGroup
      .append("text")
      .attr("class", "radar-axis-label")
      .attr("x", lx)
      .attr("y", ly)
      .text(name);
  });

  radarPath = sectorG.append("path").attr("class", "radar-polygon");

  radarPointsGroup = sectorG.append("g").attr("class", "radar-points");

  // Legend
  const legend = d3.select("#sector-legend");
  const items = legend
    .selectAll(".sector-legend-item")
    .data(SECTOR_ORDER)
    .enter()
    .append("div")
    .attr("class", "sector-legend-item");

  items
    .append("span")
    .attr("class", "sector-legend-swatch")
    .style("background-color", (d) => sectorColorScale(d));

  items.append("span").text((d) => d);
}

function updateSectorFromKey(iso, year, countryName) {
  const key = `${iso}_${year}`;
  const entry = sectorDataByKey[key];

  if (!sectorSvg) {
    initSectorViz();
  }

  if (!entry || !entry.sectors) {
    if (sectorTitleEl) sectorTitleEl.textContent = countryName || "No data";
    if (sectorYearPillEl) sectorYearPillEl.textContent = year;
    if (sectorSubtitleEl) {
      sectorSubtitleEl.textContent =
        "No detailed sector breakdown available for this country/year.";
    }
    return;
  }

  const sectorsObj = entry.sectors;
  const data = SECTOR_ORDER.map((name) => ({
    name,
    value: sectorsObj[name] || 0,
    color: sectorColorScale(name),
  }));

  updateSectorMetrics(data);

  const maxVal = d3.max(data, (d) => d.value) || 1;
  const rScale = d3
    .scaleLinear()
    .domain([0, maxVal])
    .range([0, radarRadius]);

  const lineRadial = d3
    .lineRadial()
    .radius((d) => rScale(d.value))
    .angle((d, i) => radarAngleScale(i))
    .curve(d3.curveCardinalClosed);

  radarPath
    .datum(data)
    .transition()
    .duration(700)
    .attr("d", lineRadial);

  const pts = radarPointsGroup.selectAll("circle").data(data);

  pts
    .enter()
    .append("circle")
    .attr("class", "radar-point")
    .attr("r", 3.5)
    .merge(pts)
    .transition()
    .duration(700)
    .attr("cx", (d, i) => {
      const angle = radarAngleScale(i) - Math.PI / 2;
      return Math.cos(angle) * rScale(d.value);
    })
    .attr("cy", (d, i) => {
      const angle = radarAngleScale(i) - Math.PI / 2;
      return Math.sin(angle) * rScale(d.value);
    })
    .attr("fill", (d) => d.color);

  pts.exit().remove();

  if (sectorTitleEl) sectorTitleEl.textContent = countryName || entry.country;
  if (sectorYearPillEl) sectorYearPillEl.textContent = year;
  if (sectorSubtitleEl) {
    sectorSubtitleEl.textContent =
      "Sector shares of total CO₂ emissions (MtCO₂e). Radius = emissions level; angle = sector.";
  }
}

// ----------------- bootstrap -----------------
initScene();
loadData();
