import httpx
from bs4 import BeautifulSoup
import asyncio
import re

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

BASE_URL = "https://letterboxd.com"


async def fetch_page(client: httpx.AsyncClient, url: str) -> str | None:
    try:
        resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=15)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return None


def parse_films_from_page(html: str) -> list[dict]:
    """
    Extrae películas del HTML de una lista/watchlist de Letterboxd.
    Letterboxd usa React components con atributos data-item-* en los contenedores.
    """
    soup = BeautifulSoup(html, "html.parser")
    films = []

    # Nuevo formato React: div.react-component con data-item-slug
    for div in soup.find_all("div", attrs={"data-item-slug": True}):
        slug = div.get("data-item-slug", "").strip()
        if not slug:
            continue

        name = div.get("data-item-full-display-name") or div.get("data-item-name") or slug
        link = div.get("data-item-link") or div.get("data-target-link") or f"/film/{slug}/"

        # Intentar extraer año del nombre (ej: "Film Title (2023)")
        year = None
        year_match = re.search(r"\((\d{4})\)\s*$", name)
        if year_match:
            year = year_match.group(1)
            name = name[:year_match.start()].strip()

        # Poster desde img hijo
        img = div.find("img", class_="image")
        poster_url = img.get("src") if img else None
        # Ignorar el poster vacío genérico
        if poster_url and "empty-poster" in poster_url:
            poster_url = None

        films.append({
            "slug": slug,
            "name": name,
            "year": year,
            "letterboxd_url": f"{BASE_URL}{link}" if link.startswith("/") else link,
            "poster": poster_url,
        })

    # Fallback: formato clásico con data-film-slug (por si acaso)
    if not films:
        for div in soup.find_all("div", attrs={"data-film-slug": True}):
            slug = div.get("data-film-slug", "").strip()
            if not slug:
                continue
            name_tag = div.find_next("img", class_="image")
            name = name_tag.get("alt", slug) if name_tag else slug
            link_tag = div.find("a")
            href = link_tag.get("href", f"/film/{slug}/") if link_tag else f"/film/{slug}/"
            films.append({
                "slug": slug,
                "name": name,
                "year": None,
                "letterboxd_url": f"{BASE_URL}{href}",
                "poster": None,
            })

    return films


def get_total_pages(html: str) -> int:
    """Detecta el número total de páginas de una lista."""
    soup = BeautifulSoup(html, "html.parser")
    # Paginación clásica
    last = soup.select_one("li.paginate-page:last-of-type a")
    if last:
        try:
            return int(last.text.strip())
        except ValueError:
            pass
    # Buscar en texto del HTML el total
    match = re.search(r"of\s+([\d,]+)\s+film", html, re.IGNORECASE)
    if match:
        total = int(match.group(1).replace(",", ""))
        return max(1, (total + 27) // 28)  # 28 por página aprox
    return 1


async def scrape_list(url: str) -> list[dict]:
    """Scrapea todas las páginas de una lista pública de Letterboxd."""
    url = url.rstrip("/") + "/"
    all_films = []

    async with httpx.AsyncClient() as client:
        html = await fetch_page(client, url)
        if not html:
            return []

        total_pages = get_total_pages(html)
        films = parse_films_from_page(html)
        all_films.extend(films)

        if total_pages > 1:
            tasks = [
                fetch_page(client, f"{url}page/{page}/")
                for page in range(2, total_pages + 1)
            ]
            results = await asyncio.gather(*tasks)
            for html_page in results:
                if html_page:
                    all_films.extend(parse_films_from_page(html_page))

    # Deduplicar por slug
    seen = set()
    unique = []
    for film in all_films:
        if film["slug"] not in seen:
            seen.add(film["slug"])
            unique.append(film)

    return unique


async def scrape_watchlist(username: str) -> list[dict]:
    """Scrapea la watchlist de un usuario."""
    url = f"{BASE_URL}/{username}/watchlist/"
    return await scrape_list(url)


async def scrape_user_lists(username: str) -> list[dict]:
    """
    Obtiene las listas públicas creadas por un usuario.
    Devuelve lista de {name, url, film_count}.
    """
    url = f"{BASE_URL}/{username}/lists/"
    lists_found = []

    async with httpx.AsyncClient() as client:
        html = await fetch_page(client, url)
        if not html:
            return []

        soup = BeautifulSoup(html, "html.parser")

        # Nuevo formato: secciones de listas con react-component o clásico
        # Buscar links que apunten a /{username}/list/
        # Patrón: links a /{username}/list/{slug}/ pero NO a /edit/ ni /detail/
        pattern = re.compile(rf"^/{re.escape(username)}/list/[^/]+/?$", re.IGNORECASE)
        seen_urls = set()

        for a in soup.find_all("a", href=pattern):
            href = a.get("href", "").rstrip("/") + "/"
            full_url = f"{BASE_URL}{href}"
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            # Subir en el DOM hasta encontrar el contenedor de la lista
            container = a.find_parent(class_=re.compile(r"list-set|list-summary|film-list")) or a.find_parent()

            # Nombre: buscar h2/h3 en el contenedor, o usar el slug
            name = ""
            if container:
                h = container.find(["h2", "h3"])
                if h:
                    name = h.get_text(strip=True)
            if not name:
                name = a.get_text(strip=True)
            if not name or name.lower() in ("edit list", "detail"):
                # Usar el slug como nombre legible
                slug_name = href.rstrip("/").split("/")[-1]
                name = slug_name.replace("-", " ").title()

            # Contar películas si hay un tag con número
            count = "?"
            if container:
                count_tag = container.find(class_=re.compile(r"count|value|num"))
                if count_tag:
                    count = count_tag.get_text(strip=True)

            lists_found.append({
                "name": name,
                "url": full_url,
                "film_count": count,
            })

        # Si no se encontró nada con ese patrón, buscar en react-components
        if not lists_found:
            for div in soup.find_all("div", attrs={"data-item-link": re.compile(r"/list/")}):
                link = div.get("data-item-link", "")
                name = div.get("data-item-name") or div.get("data-item-full-display-name") or link
                lists_found.append({
                    "name": name,
                    "url": f"{BASE_URL}{link}",
                    "film_count": "?",
                })

    return lists_found


async def scrape_liked_lists(username: str) -> list[dict]:
    """
    Obtiene las listas públicas a las que un usuario ha dado like.
    Devuelve lista de {name, url, film_count}.
    La URL base /likes/lists/ devuelve 403, pero /likes/lists/page/N/ funciona.
    """
    lists_found = []
    seen_urls = set()

    async with httpx.AsyncClient() as client:
        page = 1
        while True:
            url = f"{BASE_URL}/{username}/likes/lists/page/{page}/"
            html = await fetch_page(client, url)
            if not html:
                break

            soup = BeautifulSoup(html, "html.parser")

            # Verificar que la página es válida (no Cloudflare challenge)
            title = soup.title.string if soup.title else ""
            if "just a moment" in title.lower():
                break

            found_in_page = 0

            # Cada lista está en un article.list-summary
            for article in soup.select("article.list-summary"):
                # El link con nombre está en h2.name a
                h2 = article.select_one("h2.name a")
                if not h2:
                    continue
                href = h2.get("href", "").rstrip("/") + "/"
                # Solo links a listas (no watchlists ni diarios)
                if not re.match(r"^/[^/]+/list/[^/]+/$", href):
                    continue

                full_url = f"{BASE_URL}{href}"
                if full_url in seen_urls:
                    continue
                seen_urls.add(full_url)
                found_in_page += 1

                name = h2.get_text(strip=True)

                # Count: buscar el texto "N films" en el article
                count = "?"
                count_match = re.search(r"([\d,]+)\s+films?", article.get_text(), re.IGNORECASE)
                if count_match:
                    count = count_match.group(1) + " films"

                lists_found.append({
                    "name": name,
                    "url": full_url,
                    "film_count": count,
                })

            if found_in_page == 0:
                break

            # Paginación
            last = soup.select_one("li.paginate-page:last-of-type a")
            if last:
                try:
                    if page >= int(last.text.strip()):
                        break
                except ValueError:
                    break
            else:
                break

            page += 1

    return lists_found


async def scrape_multiple_sources(sources: list[str]) -> list[dict]:
    """
    Scrapea varias URLs en paralelo y combina los resultados sin duplicados.
    """
    tasks = [scrape_list(url) for url in sources]
    results = await asyncio.gather(*tasks)

    seen = set()
    combined = []
    for film_list in results:
        for film in film_list:
            if film["slug"] not in seen:
                seen.add(film["slug"])
                combined.append(film)

    return combined
