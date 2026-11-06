# ZPL²PDF Studio — Interface Web + Fluxo Shopee / UpSeller

Interface web para o conversor [brunoleocam/ZPL2PDF](https://github.com/brunoleocam/ZPL2PDF) com módulo completo para **Etiquetas Shopee (`:Z64:`) + Lista de Empacotamento Excel (`.xlsx`) do UpSeller** (leitura automática de Code 128, inserção de SKU numerada `1. SKU *1` no rodapé e geração de PDF 100×150 mm diretamente no navegador).

---

## ☁️ Hospedagem 100% Gratuita na Nuvem (Sem precisar de servidor pago)

O módulo de **Etiquetas Shopee (`:Z64:`) + Excel UpSeller + Geração de PDF 100×150 mm** roda **100% no navegador**. O projeto já inclui os arquivos de configuração prontos para você publicar gratuitamente em qualquer uma das plataformas abaixo:

### Opção A — GitHub Pages (Automático pelo GitHub)
O arquivo `.github/workflows/deploy-pages.yml` já está configurado:
1. Envie/sincronize o código para o seu repositório no GitHub.
2. No seu repositório do GitHub, clique em **Settings** (Configurações) ➔ **Pages** (no menu lateral esquerdo).
3. Em **Build and deployment > Source**, selecione **GitHub Actions**.
4. Pronto! Em ~30 segundos seu site estará no ar gratuitamente em:
   `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`

### Opção B — Vercel (Grátis, em 30 segundos)
O arquivo `vercel.json` já aponta automaticamente para a pasta `ui/`:
1. Acesse [vercel.com](https://vercel.com) e entre com sua conta do GitHub.
2. Clique em **Add New... ➔ Project** e importe o seu repositório.
3. Clique direto em **Deploy** (não precisa mudar nada).

### Opção C — Netlify ou Cloudflare Pages (Grátis)
O arquivo `netlify.toml` já configura o diretório `ui/`:
- **No Netlify:** Importe o repositório do GitHub em [app.netlify.com](https://app.netlify.com) e clique em **Deploy**. (Ou arraste a pasta `ui/` em [app.netlify.com/drop](https://app.netlify.com/drop) para publicar na hora sem nem usar Git).
- **No Cloudflare Pages:** Importe o repositório e defina **Build output directory** como `ui`.

---

## ⚡ Rodando Localmente com Docker (API C# + UI)

```bash
# 1. Suba a API + Interface com Docker Compose
docker compose up -d

# 2. Abra no navegador
# Interface: http://localhost:8080
# API direta: http://localhost:5000
```

---

## 📁 Estrutura do Projeto

```
zpl2pdf-ui/
├── .github/workflows/deploy-pages.yml  # Deploy gratuito automático no GitHub Pages
├── vercel.json                         # Deploy gratuito automático na Vercel
├── netlify.toml                        # Deploy gratuito automático no Netlify
├── docker-compose.yml                  # Sobe API + UI localmente com um comando
├── nginx.conf                          # Proxy reverso para o Docker local
├── ui/
│   ├── index.html                      # Interface principal
│   ├── fonts/                          # Fontes locais (Figtree + IBM Plex Mono)
│   ├── lib/                            # JSZip, SheetJS (XLSX) e ZXing locais
│   └── js/
│       ├── diag-logger.js              # Console de diagnóstico + Gerador de PDF 100x150mm no navegador
│       ├── zpl-bitmap.js               # Decodificador/Codificador :Z64:, escala e filtro de blocos
│       ├── barcode-reader.js           # Leitor de Code 128 no bitmap da etiqueta
│       ├── excel-parser.js             # Leitor da Lista de Empacotamento (.xlsx/.csv)
│       ├── matcher-injector.js         # Associação Rastreio <-> Excel e formatação (1. SKU *1)
│       └── upseller-ui.js              # Painel de conferência, prévia e edição
└── README.md
```

---

## 📄 Licença

MIT — interface criada sobre o projeto [brunoleocam/ZPL2PDF](https://github.com/brunoleocam/ZPL2PDF) (MIT).
