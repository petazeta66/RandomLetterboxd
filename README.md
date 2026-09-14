# Letterboxd Randomizer

Selecciona una película al azar de tus listas de Letterboxd, filtrando por género.

![Screenshot](recursos/LetterboxdRandomiser.png)

## Uso rápido

1. **Fuentes** — elige cómo cargar películas:
   - Escribe un usuario y pulsa **Cargar watchlist** para añadir su watchlist
   - Pulsa **Ver sus listas** para ver todas sus listas públicas y seleccionar las que quieras
   - Pega URLs de listas públicas de Letterboxd directamente
   - Puedes combinar varias fuentes (los duplicados se eliminan automáticamente)
2. **Cargar películas** — pulsa el botón y espera mientras el scraper y TMDB hacen su trabajo.
3. **Filtros** — selecciona uno o varios géneros (o todos).
4. **¡Elegir al azar!** — pulsa el botón y disfruta.

---

## Ejecutar en local

### Requisitos

- Python 3.10+
- Token Bearer de TMDB — gratis en https://www.themoviedb.org/settings/api

### Backend

```bash
cd backend
pip install -r requirements.txt
```

Crea el archivo `backend/.env` a partir del ejemplo:

```
TMDB_API_TOKEN=tu_token_bearer_aqui
FRONTEND_URL=*
```

Arranca el servidor:

```bash
uvicorn main:app --reload
```

El backend quedará en `http://127.0.0.1:8000`.

### Frontend

Abre `frontend/index.html` directamente en el navegador. No necesita servidor web.

---

## Despliegue gratuito (Render + Vercel)

### Prerrequisitos

- Cuenta en [Render](https://render.com) (gratis)
- Cuenta en [Vercel](https://vercel.com) (gratis)
- Repositorio en GitHub con este código

### Paso 1 — Subir el código a GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

> **Importante:** asegúrate de que `backend/.env` está en `.gitignore` para no subir tu token.

### Paso 2 — Desplegar el backend en Render

1. Ve a [render.com](https://render.com) → **New → Web Service**
2. Conecta tu repositorio de GitHub
3. Configura el servicio:
   - **Root Directory:** `backend`
   - **Runtime:** Python
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. En **Environment Variables** añade:
   - `TMDB_API_TOKEN` → tu token de TMDB
   - `FRONTEND_URL` → déjalo vacío por ahora (lo añades después del paso 3)
5. Pulsa **Create Web Service** y espera a que arranque.
6. Copia la URL del servicio (algo como `https://letterboxd-randomizer-api.onrender.com`).

> El plan gratuito de Render duerme tras 15 min de inactividad. La primera petición puede tardar ~30 s en despertar.

### Paso 3 — Desplegar el frontend en Vercel

1. Ve a [vercel.com](https://vercel.com) → **New Project**
2. Importa tu repositorio de GitHub
3. Configura el proyecto:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Other
4. En **Environment Variables** añade:
   - `API_BASE` → la URL de Render del paso anterior (sin barra final), por ejemplo: `https://letterboxd-randomizer-api.onrender.com`
5. Pulsa **Deploy** y espera.
6. Copia la URL de Vercel (algo como `https://letterboxd-randomizer.vercel.app`).

### Paso 4 — Conectar backend con frontend (CORS)

1. Vuelve al dashboard de Render → tu servicio → **Environment**
2. Actualiza `FRONTEND_URL` con la URL de Vercel del paso 3
3. Render redesplegará automáticamente.

¡Listo! Tu app estará disponible en la URL de Vercel.

---

## Variables de entorno

### Backend (`backend/.env`)

| Variable | Descripción | Ejemplo |
|---|---|---|
| `TMDB_API_TOKEN` | Token Bearer de TMDB | `eyJhbGc...` |
| `FRONTEND_URL` | URL del frontend (para CORS) | `https://mi-app.vercel.app` |

### Frontend (Vercel → Environment Variables)

| Variable | Descripción | Ejemplo |
|---|---|---|
| `API_BASE` | URL base del backend en Render | `https://mi-api.onrender.com` |
