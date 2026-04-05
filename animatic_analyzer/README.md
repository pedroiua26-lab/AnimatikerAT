# Animatic Analyzer (Backend)

FastAPI service for animatic scene/shot detection using PySceneDetect.

## Features

- `POST /analyze/` accepts a video upload and returns scene boundaries in frames.
- Uses `ContentDetector` from `scenedetect`.
- Saves uploaded files to `uploads/`.
- Saves analysis JSON reports to `outputs/`.
- Includes CORS middleware for browser-based clients.

## Local Setup

```bash
cd animatic_analyzer
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

API available at `http://127.0.0.1:8000`.

### Analyze Endpoint

```bash
curl -X POST \
  -F "file=@/path/to/animatic.mp4" \
  http://127.0.0.1:8000/analyze/
```

Example response:

```json
[
  {
    "scene": 1,
    "start_frame": 0,
    "end_frame": 120,
    "duration_frames": 120
  },
  {
    "scene": 2,
    "start_frame": 120,
    "end_frame": 245,
    "duration_frames": 125
  }
]
```

## Deploy Backend to Render

1. Push repository to GitHub.
2. In Render, choose **New +** → **Blueprint**.
3. Connect the repository and select branch.
4. Render will read `animatic_analyzer/render.yaml` and create the API service.
5. After deploy, use the generated URL (for example `https://animatic-analyzer-api.onrender.com`) as frontend backend URL.

## Deploy Frontend to GitHub Pages

1. Commit and push the `frontend/` directory.
2. In GitHub repository settings, open **Pages**.
3. Set Source to **Deploy from a branch**.
4. Select your branch and `/frontend` folder.
5. Save and wait for Pages deployment.
6. Open deployed site and set **Backend API URL** to your Render URL.

## Notes

- The backend currently allows all origins (`*`) for MVP simplicity.
- For production, lock down CORS origins and add authentication plus size limits.
