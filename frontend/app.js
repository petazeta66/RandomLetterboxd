// ── Config ───────────────────────────────────────────────────────────────────
// En producción esta variable se sobreescribe por el build de Vercel.
// En local apunta al backend de desarrollo.
const API_BASE = window.ENV_API_BASE || "http://127.0.0.1:8000";
const TMDB_IMG  = "https://image.tmdb.org/t/p/w300";

// ── Estado ───────────────────────────────────────────────────────────────────
const state = {
  allFilms: [],          // Películas crudas del scraper
  enrichedFilms: [],     // Películas con géneros e info de TMDB
  selectedGenres: new Set(),
  minRating: 0,          // Rating mínimo (0 = sin filtro, 1-10 = valor)
  availableGenres: [],   // [{id, name}]
  activeSources: [],     // [{label, url}]
  onlyShared: false,     // Mostrar solo películas compartidas entre fuentes
  sharedMin: 2,          // Nº mínimo de fuentes en las que debe aparecer una película
  loadedUrls: [],        // URLs usadas en la ultima carga
  loadedSources: [],     // [{url, count}] fuentes que realmente devolvieron películas
};

// Escala interna del rating: 0-10 (la misma que usa TMDB). 2 puntos = 1 estrella.
const RATING_MAX = 10;

// ── Utilidades ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showLoader(text = "Cargando...") {
  $("loader-text").textContent = text;
  $("loader").classList.remove("hidden");
}

function hideLoader() {
  $("loader").classList.add("hidden");
}

let toastTimer = null;
function showToast(msg, type = "info", duration = 3500) {
  const el = $("toast");
  el.textContent = msg;
  el.className = type;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── TMDB (proxy a través del backend — el token nunca llega al navegador) ─────
// Los endpoints individuales se mantienen por si se necesitan en el futuro,
// pero el flujo principal usa /api/films/enriched que lo hace todo en el servidor.
async function tmdbSearch(title, year) {
  const params = new URLSearchParams({ query: title });
  if (year) params.set("year", year);
  try {
    const res = await fetch(`${API_BASE}/api/tmdb/search?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0] ?? null;
  } catch {
    return null;
  }
}

async function tmdbDetails(tmdbId) {
  try {
    const res = await fetch(`${API_BASE}/api/tmdb/details/${tmdbId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Enriquecer un lote de películas con datos de TMDB (en paralelo, lotes de 10)
async function enrichFilms(films) {
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < films.length; i += BATCH) {
    const batch = films.slice(i, i + BATCH);
    const enriched = await Promise.all(batch.map(async (film) => {
      const tmdb = await tmdbSearch(film.name, film.year);
      if (!tmdb) return { ...film, genres: [], tmdbData: null };
      return {
        ...film,
        genres: tmdb.genre_ids ?? [],
        tmdbData: {
          id: tmdb.id,
          overview: tmdb.overview,
          poster_path: tmdb.poster_path,
          release_date: tmdb.release_date,
          vote_average: tmdb.vote_average,
        },
      };
    }));
    results.push(...enriched);
    showLoader(`Obteniendo info de TMDB... (${Math.min(i + BATCH, films.length)}/${films.length})`);
  }

  return results;
}

// Cargar el catálogo de géneros de TMDB
async function fetchGenreList() {
  try {
    const res = await fetch(`${API_BASE}/api/tmdb/genres`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.genres ?? [];
  } catch {
    return [];
  }
}

// ── LETTERBOXD ────────────────────────────────────────────────────────────────
async function loadFilmsEnriched(urls) {
  const res = await fetch(`${API_BASE}/api/films/enriched`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: urls }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "Error al cargar películas");
  }
  return await res.json(); // { films, genres, count }
}

async function loadUserLists(username) {
  const res = await fetch(`${API_BASE}/api/user-lists/${encodeURIComponent(username)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "No se pudieron cargar las listas");
  }
  return (await res.json()).lists;
}

async function loadLikedLists(username) {
  const res = await fetch(`${API_BASE}/api/liked-lists/${encodeURIComponent(username)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "No se pudieron cargar las listas con like");
  }
  return (await res.json()).lists;
}

// ── FUENTES ACTIVAS ───────────────────────────────────────────────────────────
function addSource(url, label) {
  if (state.activeSources.find(s => s.url === url)) return;
  state.activeSources.push({ url, label });
  renderActiveSources();
}

function removeSource(url) {
  state.activeSources = state.activeSources.filter(s => s.url !== url);
  renderActiveSources();
}

function renderActiveSources() {
  const list = $("active-sources-list");
  const panel = $("active-sources");

  if (state.activeSources.length === 0) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  list.innerHTML = state.activeSources.map(s => `
    <li>
      <span class="source-label">${escapeHtml(s.label)}</span>
      <span style="cursor:pointer;color:var(--danger)" data-url="${escapeHtml(s.url)}" class="remove-source">✕</span>
    </li>
  `).join("");

  list.querySelectorAll(".remove-source").forEach(btn => {
    btn.addEventListener("click", () => removeSource(btn.dataset.url));
  });
}

function toggleShared() {
  if (state.loadedSources.length < 2) {
    showToast("Necesitas cargar 2 o más fuentes para filtrar por películas compartidas.", "error");
    return;
  }
  state.onlyShared = !state.onlyShared;
  updateSharedToggleUI();
  updateFilmCount();
}

function sharedFilmCount(min) {
  return state.enrichedFilms.filter(f => (f.source_count ?? 1) >= min).length;
}

function updateSharedToggleUI() {
  const btn = $("btn-toggle-shared");
  const info = $("shared-info");
  const minBox = $("shared-min");
  if (!btn) return;

  const total = state.loadedSources.length;
  const canShare = total > 1;

  // Ojo: no usamos el atributo `disabled` — un botón deshabilitado no emite
  // eventos de clic y el usuario se queda sin saber por qué no pasa nada.
  btn.classList.toggle("locked", !canShare);
  btn.setAttribute("aria-disabled", String(!canShare));

  if (!canShare) state.onlyShared = false;
  state.sharedMin = Math.max(2, Math.min(state.sharedMin, Math.max(2, total)));

  btn.classList.toggle("active", state.onlyShared);
  btn.setAttribute("aria-pressed", String(state.onlyShared));
  btn.querySelector(".toggle-icon").textContent = state.onlyShared ? "◉" : "◎";

  if (!canShare) {
    info.textContent = "Carga 2 o más fuentes (watchlists, listas o URLs) para poder cruzarlas.";
    info.classList.remove("hidden");
    minBox.classList.add("hidden");
    minBox.innerHTML = "";
    return;
  }

  if (!state.onlyShared) {
    info.classList.add("hidden");
    minBox.classList.add("hidden");
    minBox.innerHTML = "";
    return;
  }

  const shared = sharedFilmCount(state.sharedMin);
  info.textContent = `${shared} película${shared !== 1 ? "s" : ""} aparecen en al menos ` +
    `${state.sharedMin} de las ${total} fuentes cargadas.`;
  info.classList.remove("hidden");

  // Con 3+ fuentes dejamos elegir cuántas deben coincidir (2, 3, ... todas)
  if (total > 2) {
    const opts = Array.from({ length: total - 1 }, (_, i) => i + 2);
    minBox.innerHTML =
      `<span class="shared-min-label">Coincidir en al menos:</span>` +
      opts.map(v => `<button type="button" class="chip${v === state.sharedMin ? " active" : ""}" ` +
        `data-min="${v}">${v === total ? `todas (${v})` : v}</button>`).join("");
    minBox.querySelectorAll("button[data-min]").forEach(b => {
      b.addEventListener("click", () => {
        state.sharedMin = Number(b.dataset.min);
        updateSharedToggleUI();
        updateFilmCount();
      });
    });
    minBox.classList.remove("hidden");
  } else {
    minBox.classList.add("hidden");
    minBox.innerHTML = "";
  }
}

function renderGenreChips() {
  const container = $("genre-chips");
  container.innerHTML = "";

  state.availableGenres.forEach(g => {
    const chip = document.createElement("div");
    chip.className = "chip" + (state.selectedGenres.has(g.id) ? " active" : "");
    chip.textContent = g.name;
    chip.dataset.id = g.id;
    chip.addEventListener("click", () => {
      if (state.selectedGenres.has(g.id)) {
        state.selectedGenres.delete(g.id);
        chip.classList.remove("active");
      } else {
        state.selectedGenres.add(g.id);
        chip.classList.add("active");
      }
      updateFilmCount();
    });
    container.appendChild(chip);
  });
}

function renderRatingStars() {
  const container = $("rating-stars-drag");
  container.innerHTML = "";

  // Crear 5 estrellas. draggable="false" evita que el navegador inicie su
  // arrastre nativo de imágenes (el cursor de "prohibido" que se quedaba pillado).
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("div");
    star.className = "rating-star-drag";
    star.dataset.starIndex = i;
    star.innerHTML = `<img src="assets/estrella_vacia.png" alt="" draggable="false" />`;
    container.appendChild(star);
  }

  updateRatingDisplay();
}

function updateRatingDisplay() {
  const container = $("rating-stars-drag");
  const stars = container.querySelectorAll(".rating-star-drag");
  const value = state.minRating;                 // 0-10, enteros (media estrella = 1)
  const fullStars = Math.floor(value / 2);
  const hasHalf = value % 2 === 1;

  stars.forEach((star, idx) => {
    const starNum = idx + 1;
    const img = star.querySelector("img");

    let src = "assets/estrella_vacia.png";
    let alt = "";
    if (starNum <= fullStars) {
      src = "assets/estrella_llena.png";
    } else if (starNum === fullStars + 1 && hasHalf) {
      src = "assets/estrella_mitad.png";
    }
    // Solo tocamos el src si cambia, para que no parpadee al arrastrar
    if (!img.getAttribute("src").endsWith(src)) img.setAttribute("src", src);
    img.alt = alt;
  });

  const outOf5 = value / 2;
  container.setAttribute("aria-valuenow", String(outOf5));
  container.setAttribute("aria-valuetext", value === 0 ? "Sin filtro" : `${outOf5.toFixed(1)} de 5`);

  const label = $("rating-label");
  label.textContent = value === 0
    ? "Sin filtro de rating"
    : `Mostrando películas con rating ≥ ${outOf5.toFixed(1)}/5`;
}

function attachRatingListeners() {
  const container = $("rating-stars-drag");
  const clearBtn = $("btn-clear-rating");
  if (!container || container.dataset.bound === "1") return;
  container.dataset.bound = "1";   // evita listeners duplicados en cada recarga

  let dragging = false;

  function setRating(value) {
    const v = Math.max(0, Math.min(RATING_MAX, value));
    if (v === state.minRating) return;
    state.minRating = v;
    updateRatingDisplay();
    updateFilmCount();
  }

  // Medimos sobre las estrellas reales, no sobre el contenedor (que tiene
  // padding). Así el extremo derecho corresponde exactamente a 5 estrellas.
  function ratingFromPointer(e) {
    const stars = container.querySelectorAll(".rating-star-drag");
    if (!stars.length) return 0;
    const first = stars[0].getBoundingClientRect();
    const last = stars[stars.length - 1].getBoundingClientRect();
    const width = last.right - first.left;
    if (width <= 0) return 0;
    const ratio = (e.clientX - first.left) / width;
    return Math.round(Math.max(0, Math.min(1, ratio)) * RATING_MAX);
  }

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    if (e && e.pointerId !== undefined) {
      try { container.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    }
  };

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    try { container.setPointerCapture(e.pointerId); } catch { /* no soportado */ }
    container.focus({ preventScroll: true });
    setRating(ratingFromPointer(e));
  });

  container.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    setRating(ratingFromPointer(e));
  });

  container.addEventListener("pointerup", stop);
  container.addEventListener("pointercancel", stop);
  window.addEventListener("pointerup", stop);
  window.addEventListener("blur", () => stop());

  // Cinturón y tirantes: si algún navegador aún intenta arrastrar, lo cortamos.
  container.addEventListener("dragstart", (e) => e.preventDefault());

  container.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 2 : 1;   // Shift = estrella entera
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault(); setRating(state.minRating + step);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault(); setRating(state.minRating - step);
    } else if (e.key === "Home") {
      e.preventDefault(); setRating(0);
    } else if (e.key === "End") {
      e.preventDefault(); setRating(RATING_MAX);
    }
  });

  if (clearBtn) clearBtn.addEventListener("click", () => setRating(0));
}

function getFilteredFilms() {
  let films = state.enrichedFilms;

  // Filtro de películas compartidas: el backend marca cada película con
  // `sources` (URLs en las que aparece) y `source_count`.
  if (state.onlyShared && state.loadedSources.length > 1) {
    const min = Math.max(2, Math.min(state.sharedMin, state.loadedSources.length));
    films = films.filter(f => (f.source_count ?? 1) >= min);
  }

  // Filtro de géneros
  if (state.selectedGenres.size > 0) {
    films = films.filter(f => f.genres.some(gid => state.selectedGenres.has(gid)));
  }

  // Filtro de rating
  if (state.minRating > 0) {
    films = films.filter(f => {
      const rating = f.tmdbData?.vote_average ?? 0;
      return rating >= state.minRating;
    });
  }

  return films;
}

function updateFilmCount() {
  const filtered = getFilteredFilms();
  const n = filtered.length;
  const plural = n !== 1 ? "s" : "";
  const hasFilters = state.selectedGenres.size > 0 || state.minRating > 0 || state.onlyShared;
  const suffix = hasFilters
    ? "con los filtros actuales"
    : "(selecciona géneros o un rating mínimo para filtrar)";
  $("film-count-label").innerHTML =
    `<strong>${n}</strong> película${plural} disponible${plural} ${suffix}`;
}

// ── RESULTADO ─────────────────────────────────────────────────────────────────
async function showRandomFilm() {
  const pool = getFilteredFilms();
  if (pool.length === 0) {
    showToast("Ninguna película pasa los filtros actuales. Prueba a bajar el rating mínimo, ampliar géneros o desactivar 'Solo compartidas'.", "error");
    return;
  }

  const film = randomFrom(pool);
  $("result-card").classList.add("hidden");

  // Si aún no tenemos detalles completos, los pedimos
  let overview = film.tmdbData?.overview ?? "";
  let poster   = film.tmdbData?.poster_path ? `${TMDB_IMG}${film.tmdbData.poster_path}` : "";
  let year     = film.year ?? film.tmdbData?.release_date?.slice(0, 4) ?? "";

  // Géneros nombres
  const genreNames = film.genres
    .map(id => state.availableGenres.find(g => g.id === id)?.name)
    .filter(Boolean);

  $("result-title").textContent = film.name;
  $("result-year").textContent  = year ? `${year}` : "";
  $("result-overview").textContent = overview || "Sin sinopsis disponible.";
  $("result-link").href = film.letterboxd_url;

  if (poster) {
    $("result-poster").src = poster;
    $("result-poster").classList.remove("hidden");
  } else {
    $("result-poster").src = "";
    $("result-poster").classList.add("hidden");
  }

  const genreChips = $("result-genres");
  genreChips.innerHTML = genreNames.map(n => `<div class="chip active">${n}</div>`).join("");

  $("result-card").classList.remove("hidden");
  $("result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── INICIALIZACIÓN ────────────────────────────────────────────────────────────
async function loadEverything() {
  const urls = getActiveUrls();
  if (urls.length === 0) {
    showToast("Añade al menos una fuente (watchlist, lista de usuario o URL).", "error");
    return;
  }

  showLoader("Revisando Letterboxd y consultando TMDB...");

  try {
    // Un solo endpoint hace scraping + enriquecimiento TMDB en paralelo en el servidor
    const { films, genres, sources } = await loadFilmsEnriched(urls);

    if (films.length === 0) {
      showToast("No se encontraron películas en las fuentes indicadas.", "error");
      return;
    }

    state.enrichedFilms = films;
    state.availableGenres = genres ?? [];   // sin esto los chips de género salían vacíos
    state.loadedUrls = urls;
    // Solo cuentan como fuente las que realmente devolvieron películas
    state.loadedSources = (sources ?? []).filter(s => (s.count ?? 0) > 0);

    // Resetear filtros
    state.selectedGenres = new Set();
    state.minRating = 0;
    state.onlyShared = false;
    state.sharedMin = 2;

    renderGenreChips();
    renderRatingStars();
    updateSharedToggleUI();
    updateFilmCount();

    $("section-filters").classList.remove("hidden");
    $("section-result").classList.remove("hidden");
    $("section-filters").scrollIntoView({ behavior: "smooth" });

    showToast(`${films.length} películas cargadas correctamente.`, "success");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    hideLoader();
  }
}

// ── URL INPUTS ────────────────────────────────────────────────────────────────
function getUrlInputValues() {
  return [...document.querySelectorAll(".url-input")]
    .map(i => i.value.trim())
    .filter(Boolean);
}

function getActiveUrls() {
  // Fuentes del panel de fuentes activas + inputs directos sin añadir
  const fromPanel = state.activeSources.map(s => s.url);
  const fromInputs = getUrlInputValues().filter(u => !fromPanel.includes(u));
  return [...new Set([...fromPanel, ...fromInputs])];
}

function addUrlInput() {
  const container = $("url-inputs");
  const row = document.createElement("div");
  row.className = "url-row";
  row.innerHTML = `
    <input type="url" class="url-input" placeholder="https://letterboxd.com/usuario/list/mi-lista/" />
    <button class="btn-icon btn-remove-url" title="Eliminar">✕</button>
  `;
  row.querySelector(".btn-remove-url").addEventListener("click", () => row.remove());
  container.appendChild(row);
  row.querySelector("input").focus();
}

// ── LISTAS DEL USUARIO ────────────────────────────────────────────────────────
async function browseUserLists() {
  const username = $("input-username").value.trim();
  if (!username) { showToast("Introduce un nombre de usuario.", "error"); return; }
  showLoader(`Cargando listas de @${username}...`);
  try {
    const lists = await loadUserLists(username);
    renderListPanel("user-lists-container", "user-lists-panel", lists);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    hideLoader();
  }
}

async function browseLikedLists() {
  const username = $("input-username").value.trim();
  if (!username) { showToast("Introduce un nombre de usuario.", "error"); return; }
  showLoader(`Cargando listas con ♥ de @${username}...`);
  try {
    const lists = await loadLikedLists(username);
    renderListPanel("liked-lists-container", "liked-lists-panel", lists);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    hideLoader();
  }
}

function renderListPanel(containerId, panelId, lists) {
  const container = $(containerId);
  const panel = $(panelId);
  container.innerHTML = "";

  if (lists.length === 0) {
    container.innerHTML = `<p class="hint">No se encontraron listas públicas.</p>`;
    panel.classList.remove("hidden");
    return;
  }

  lists.forEach(list => {
    const item = document.createElement("div");
    item.className = "list-item";
    const uid = `list-${containerId}-${encodeURIComponent(list.url)}`;
    item.innerHTML = `
      <input type="checkbox" id="${uid}" />
      <label class="list-name" for="${uid}">${escapeHtml(list.name)}</label>
      <span class="list-count">${escapeHtml(String(list.film_count))}</span>
    `;
    const checkbox = item.querySelector("input");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        item.classList.add("selected");
        addSource(list.url, list.name);
      } else {
        item.classList.remove("selected");
        removeSource(list.url);
      }
    });
    item.addEventListener("click", (e) => { if (e.target !== checkbox) checkbox.click(); });
    container.appendChild(item);
  });

  panel.classList.remove("hidden");
}

// ── WATCHLIST ─────────────────────────────────────────────────────────────────
async function loadWatchlist() {
  const username = $("input-username").value.trim();
  if (!username) {
    showToast("Introduce un nombre de usuario.", "error");
    return;
  }
  const url = `https://letterboxd.com/${username}/watchlist/`;
  addSource(url, `@${username} — watchlist`);
  showToast(`Watchlist de @${username} añadida.`, "success");
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
// Helper defensivo: si un id desaparece del HTML, avisamos por consola en vez de
// romper el resto de listeners (era justo lo que pasaba con btn-select-all-genres).
function on(id, event, handler) {
  const el = $(id);
  if (!el) { console.warn(`[app] No existe el elemento #${id}; listener omitido.`); return; }
  el.addEventListener(event, handler);
}

document.addEventListener("DOMContentLoaded", () => {
  on("btn-add-url", "click", addUrlInput);

  // Eliminar primera fila de URL si hay más de una
  on("url-inputs", "click", (e) => {
    if (e.target.classList.contains("btn-remove-url")) {
      const rows = document.querySelectorAll(".url-row");
      if (rows.length > 1) {
        e.target.closest(".url-row").remove();
      } else {
        e.target.closest(".url-row").querySelector("input").value = "";
      }
    }
  });

  on("btn-load-watchlist", "click", loadWatchlist);
  on("btn-browse-lists", "click", browseUserLists);
  on("btn-browse-liked", "click", browseLikedLists);
  on("btn-load-films", "click", loadEverything);

  on("btn-randomize", "click", showRandomFilm);

  on("btn-select-all-genres", "click", () => {
    state.selectedGenres = new Set(state.availableGenres.map(g => g.id));
    renderGenreChips();
    updateFilmCount();
  });

  on("btn-clear-genres", "click", () => {
    state.selectedGenres.clear();
    renderGenreChips();
    updateFilmCount();
  });

  // Toggle de películas compartidas (un único listener: el onclick inline del
  // HTML se ha eliminado porque disparaba el toggle dos veces por clic).
  on("btn-toggle-shared", "click", toggleShared);

  // El slider de estrellas se enlaza una sola vez; las estrellas se repintan
  // después en cada carga sin volver a registrar listeners.
  attachRatingListeners();

  // Añadir URL con Enter
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("url-input")) {
      $("btn-load-films").click();
    }
  });
});
