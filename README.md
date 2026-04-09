# ZPL²PDF Studio — Interface Web

Interface web elegante para o conversor [brunoleocam/ZPL2PDF](https://github.com/brunoleocam/ZPL2PDF).

---

## ⚡ Início Rápido — Docker (recomendado)

```bash
# 1. Suba tudo com Docker Compose
docker compose up -d

# 2. Abra no browser
# Interface: http://localhost:8080
# API direta: http://localhost:5000
```

Pronto! O ZPL2PDF já roda como servidor de API local.

---

## 🖥️ Sem Docker — rodar a API manualmente

### Windows (WinGet)
```powershell
winget install brunoleocam.ZPL2PDF
ZPL2PDF --api --host localhost --port 5000
```

### Linux (Ubuntu/Debian)
```bash
wget https://github.com/brunoleocam/ZPL2PDF/releases/download/v3.1.1/ZPL2PDF-v3.1.1-linux-amd64.deb
sudo dpkg -i ZPL2PDF-v3.1.1-linux-amd64.deb
zpl2pdf --api --host 0.0.0.0 --port 5000
```

### macOS
```bash
curl -L https://github.com/brunoleocam/ZPL2PDF/releases/download/v3.1.1/ZPL2PDF-v3.1.1-osx-arm64.tar.gz -o zpl2pdf.tar.gz
tar -xzf zpl2pdf.tar.gz
./ZPL2PDF --api --host localhost --port 5000
```

Depois abra `ui/index.html` direto no browser — ou sirva com qualquer servidor HTTP.

---

## 📁 Estrutura

```
zpl2pdf-ui/
├── docker-compose.yml   # Sobe API + UI com um comando
├── nginx.conf           # Proxy reverso para a API
├── ui/
│   └── index.html       # Interface completa (zero dependências)
└── README.md
```

---

## ✨ Funcionalidades da Interface

- **Editor ZPL** com numeração de linhas e suporte a Tab
- **6 exemplos prontos**: etiqueta simples, Code 128, Code 39, QR Code, etiqueta completa, multi-label
- **Upload** de arquivos `.zpl`, `.txt`, `.prn`
- **Preview inline** do PDF ou PNG gerado
- **Seleção de DPI**: 152 / 203 / 300 / 600
- **Motor de renderização**: offline (local) / auto / labelary
- **Download** do arquivo convertido
- **Indicador de status** da API em tempo real
- **Atalho** `Ctrl+Enter` para converter

---

## 🔧 Configuração da URL da API

Por padrão a UI conecta em `http://localhost:5000`. Para alterar, edite a linha no `ui/index.html`:

```js
const API_BASE = 'http://localhost:5000'; // ← mude aqui
```

---

## 📄 Licença

MIT — interface criada sobre o projeto [brunoleocam/ZPL2PDF](https://github.com/brunoleocam/ZPL2PDF) (MIT).
