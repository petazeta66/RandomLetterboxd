from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import os
import httpx
from dotenv import load_dotenv

from scraper import (
    scrape_list,
    scrape_watchlist,
    scrape_user_lists,
    scrape_liked_lists,
    scrape_multiple_sources,
)

load_dotenv()

app = FastAPI(title="Letterboxd Randomizer API")

FRONTEND_URL = os.getenv("FRONTEND_URL", "*")
TMDB_BASE = "https://api.themoviedb.org/3"

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL] if FRONTEND_URL != "*" else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_tmdb_headers() -> dict:
    token = os.getenv("TMDB_API_TOKEN", "")
    if not token:
        raise HTTPException(status_code=500, detail="TMDB_API_TOKEN no configurado en el servidor.")
    return {"Authorization": f"Bearer {token}"}


# ── Modelos ──────────────────────────────────────────────────────────────────

class ScrapeRequest(BaseModel):
    sources: list[str]          # Lista de URLs de Letterboxd


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/films")
async def get_films(req: ScrapeRequest):
    """
    Recibe una lista de URLs de Letterboxd (listas o watchlists)
    y devuelve todas las películas combinadas sin duplicados.
    """
    if not req.sources:
        raise HTTPException(status_code=400, detail="Debes proporcionar al menos una URL.")

    films = await scrape_multiple_sources(req.sources)

    if not films:
        raise HTTPException(status_code=404, detail="No se encontraron películas en las fuentes indicadas.")

    return {"count": len(films), "films": films}


@app.get("/api/watchlist/{username}")
async def get_watchlist(username: str):
    """Devuelve la watchlist de un usuario de Letterboxd."""
    films = await scrape_watchlist(username)
    if not films:
        raise HTTPException(status_code=404, detail=f"No se encontró watchlist para '{username}' o está vacía.")
    return {"count": len(films), "films": films}


@app.get("/api/user-lists/{username}")
async def get_user_lists(username: str):
    """Devuelve las listas públicas creadas por un usuario."""
    lists = await scrape_user_lists(username)
    if not lists:
        raise HTTPException(status_code=404, detail=f"No se encontraron listas para '{username}'.")
    return {"lists": lists}


@app.get("/api/liked-lists/{username}")
async def get_liked_lists(username: str):
    """Devuelve las listas a las que un usuario ha dado like."""
    lists = await scrape_liked_lists(username)
    if not lists:
        raise HTTPException(status_code=404, detail=f"No se encontraron listas con like para '{username}'.")
    return {"lists": lists}


# ── Endpoints TMDB (proxy seguro — el token nunca sale del servidor) ──────────

@app.get("/api/tmdb/search")
async def tmdb_search(query: str = Query(...), year: Optional[str] = Query(None)):
    """Busca una película en TMDB por título y año opcional."""
    params = {"query": query, "language": "es-ES"}
    if year:
        params["year"] = year
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{TMDB_BASE}/search/movie",
            params=params,
            headers=get_tmdb_headers(),
            timeout=10,
        )
    if not resp.is_success:
        raise HTTPException(status_code=resp.status_code, detail="Error en TMDB search.")
    return resp.json()


@app.get("/api/tmdb/details/{tmdb_id}")
async def tmdb_details(tmdb_id: int):
    """Devuelve los detalles completos de una película de TMDB."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{TMDB_BASE}/movie/{tmdb_id}",
            params={"language": "es-ES"},
            headers=get_tmdb_headers(),
            timeout=10,
        )
    if not resp.is_success:
        raise HTTPException(status_code=resp.status_code, detail="Error en TMDB details.")
    return resp.json()


@app.get("/api/tmdb/genres")
async def tmdb_genres():
    """Devuelve el catálogo de géneros de TMDB."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{TMDB_BASE}/genre/movie/list",
            params={"language": "es-ES"},
            headers=get_tmdb_headers(),
            timeout=10,
        )
    if not resp.is_success:
        raise HTTPException(status_code=resp.status_code, detail="Error obteniendo géneros de TMDB.")
    return resp.json()
