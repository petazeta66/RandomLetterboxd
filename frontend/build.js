// Script de build para Vercel — reemplaza el placeholder con la URL real del backend.
// Vercel inyecta la variable de entorno API_BASE en build time.
const fs = require("fs");
const path = require("path");

const apiBase = process.env.API_BASE;
if (!apiBase) {
  console.error("ERROR: la variable de entorno API_BASE no está definida.");
  console.error("Configúrala en el dashboard de Vercel (Settings → Environment Variables).");
  process.exit(1);
}

const indexPath = path.join(__dirname, "index.html");
let html = fs.readFileSync(indexPath, "utf8");

html = html.replace("VITE_API_BASE_PLACEHOLDER", apiBase);

fs.writeFileSync(indexPath, html, "utf8");
console.log(`✓ API_BASE inyectada: ${apiBase}`);
