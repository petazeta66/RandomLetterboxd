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
  availableGenres: [],   // [{id, name}]
  activeSources: [],     // [{label, url}]
};

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
async function loadFilmsFromSources(urls) {
  const res = await fetch(`${API_BASE}/api/films`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: urls }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "Error al cargar películas");
  }
  return (await res.json()).films;
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

// ── GÉNEROS ───────────────────────────────────────────────────────────────────
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

function getFilteredFilms() {
  if (state.selectedGenres.size === 0) return state.enrichedFilms;
  return state.enrichedFilms.filter(f =>
    f.genres.some(gid => state.selectedGenres.has(gid))
  );
}

function updateFilmCount() {
  const filtered = getFilteredFilms();
  $("film-count-label").innerHTML =
    `<strong>${filtered.length}</strong> película${filtered.length !== 1 ? "s" : ""} disponible${filtered.length !== 1 ? "s" : ""} con los filtros actuales`;
}

// ── RESULTADO ─────────────────────────────────────────────────────────────────
async function showRandomFilm() {
  const pool = getFilteredFilms();
  if (pool.length === 0) {
    showToast("No hay películas con los géneros seleccionados.", "error");
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

  showLoader("Scrapeando Letterboxd...");

  try {
    const films = await loadFilmsFromSources(urls);
    if (films.length === 0) {
      showToast("No se encontraron películas en las fuentes indicadas.", "error");
      return;
    }

    showLoader(`Consultando TMDB para ${films.length} películas...`);
    const genres = await fetchGenreList();
    state.availableGenres = genres;

    const enriched = await enrichFilms(films);
    state.enrichedFilms = enriched;

    // Géneros presentes en las películas
    const presentIds = new Set(enriched.flatMap(f => f.genres));
    state.availableGenres = genres.filter(g => presentIds.has(g.id));

    // Seleccionar todos por defecto
    state.selectedGenres = new Set(state.availableGenres.map(g => g.id));

    renderGenreChips();
    updateFilmCount();

    $("section-filters").classList.remove("hidden");
    $("section-result").classList.remove("hidden");
    $("section-filters").scrollIntoView({ behavior: "smooth" });

    showToast(`${enriched.length} películas cargadas correctamente.`, "success");
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
document.addEventListener("DOMContentLoaded", () => {
  $("btn-add-url").addEventListener("click", addUrlInput);

  // Eliminar primera fila de URL si hay más de una
  $("url-inputs").addEventListener("click", (e) => {
    if (e.target.classList.contains("btn-remove-url")) {
      const rows = document.querySelectorAll(".url-row");
      if (rows.length > 1) {
        e.target.closest(".url-row").remove();
      } else {
        e.target.closest(".url-row").querySelector("input").value = "";
      }
    }
  });

  $("btn-load-watchlist").addEventListener("click", loadWatchlist);
  $("btn-browse-lists").addEventListener("click", browseUserLists);
  $("btn-browse-liked").addEventListener("click", browseLikedLists);
  $("btn-load-films").addEventListener("click", loadEverything);

  $("btn-randomize").addEventListener("click", showRandomFilm);

  $("btn-select-all-genres").addEventListener("click", () => {
    state.selectedGenres = new Set(state.availableGenres.map(g => g.id));
    renderGenreChips();
    updateFilmCount();
  });

  $("btn-clear-genres").addEventListener("click", () => {
    state.selectedGenres.clear();
    renderGenreChips();
    updateFilmCount();
  });

  // Añadir URL con Enter
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("url-input")) {
      $("btn-load-films").click();
    }
  });
});
