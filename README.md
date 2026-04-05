# Animatic Analyzer MVP

Production-ready MVP web app for uploading animatic videos and detecting scenes.

## Project Structure

```text
animatic_analyzer/
├── app/
│   ├── main.py
│   ├── scenes.py
│   └── utils.py
├── uploads/
├── outputs/
├── requirements.txt
├── render.yaml
└── README.md

frontend/
├── index.html
├── script.js
└── style.css
```

## Quick Start

### Backend

```bash
cd animatic_analyzer
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend

Serve `frontend/` with any static server or GitHub Pages, then point **Backend API URL** to your running backend.

For deployment instructions, see `animatic_analyzer/README.md`.
