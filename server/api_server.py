#!/usr/bin/env python3
"""Reflect — voice note capture + structured reflection.

Runs on port 8000. Two external calls per note, both against the user's own
OpenAI account (auth injected transparently via the custom-credentials proxy):
  1. POST /v1/audio/transcriptions   — speech to text
  2. POST /v1/chat/completions       — transcript -> {summary, themes, tensions, next_actions}
"""
import json
import os
import sqlite3
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

# Named data.db at the project root per platform convention, so it survives redeploys.
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data.db")
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"
ANALYZE_MODEL = "gpt-4o-mini"

# On Render, the key is a plain environment variable set in the dashboard —
# no proxy involved, so we call OpenAI directly with standard Bearer auth.
OPENAI_BASE_URL = "https://api.openai.com"
OPENAI_TOKEN = os.environ.get("OPENAI_API_KEY", "")

SYSTEM_PROMPT = (
    "You help a behavioural strategist and executive coach turn a raw, spoken "
    "voice note into structured reflection they can act on. You will be given "
    "a transcript of loose, possibly rambling spoken thoughts recorded between "
    "client sessions, workshops, or board meetings. Read it carefully and "
    "return strict JSON with exactly these keys:\n"
    '  "summary": one plain sentence capturing the core of the note.\n'
    '  "themes": an array of short phrases (3-6 words) naming recurring ideas '
    "or subjects raised — the *what*.\n"
    '  "tensions": an array of short phrases naming contradictions, open '
    "questions, unresolved friction, or competing pressures in the note — the "
    '"pull" points worth sitting with.\n'
    '  "next_actions": an array of short, concrete, verb-first next steps '
    "implied or stated in the note.\n"
    "If a category genuinely has nothing to offer, return an empty array for "
    "it rather than inventing content. Do not add commentary outside the JSON."
)


def db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


_conn = db()
_conn.execute(
    """
    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER,
        visitor_id TEXT,
        transcript TEXT,
        summary TEXT,
        themes TEXT,
        tensions TEXT,
        next_actions TEXT,
        demo INTEGER DEFAULT 0
    )
    """
)
_conn.commit()


def visitor_id_of(request: Request) -> str:
    # Every request through the sandbox proxy carries this header, uniquely
    # identifying the browser. Falls back to "local" for direct localhost testing.
    return request.headers.get("x-visitor-id", "local")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    _conn.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "transcript": row["transcript"],
        "summary": row["summary"],
        "themes": json.loads(row["themes"] or "[]"),
        "tensions": json.loads(row["tensions"] or "[]"),
        "next_actions": json.loads(row["next_actions"] or "[]"),
        "demo": bool(row["demo"]),
    }


async def transcribe_audio(client: httpx.AsyncClient, audio_bytes: bytes, filename: str, content_type: str) -> str:
    if not OPENAI_TOKEN:
        raise RuntimeError("OpenAI credential not configured")
    resp = await client.post(
        f"{OPENAI_BASE_URL}/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {OPENAI_TOKEN}"},
        files={"file": (filename, audio_bytes, content_type or "audio/webm")},
        data={"model": TRANSCRIBE_MODEL},
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["text"]


async def analyze_transcript(client: httpx.AsyncClient, transcript: str) -> dict:
    if not OPENAI_TOKEN:
        raise RuntimeError("OpenAI credential not configured")
    resp = await client.post(
        f"{OPENAI_BASE_URL}/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_TOKEN}"},
        json={
            "model": ANALYZE_MODEL,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": transcript},
            ],
        },
        timeout=120,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    return json.loads(content)


DEMO_TRANSCRIPT = (
    "Demo transcript — connect your OpenAI key to transcribe real voice notes. "
    "This stand-in shows roughly what a raw, spoken reflection looks like before "
    "it gets structured: thinking out loud about a client's leadership team, "
    "noticing that two board members keep circling the same succession question "
    "without resolving it, and wanting to follow up before the next committee "
    "meeting."
)
DEMO_RESULT = {
    "summary": "A reflection on a client's board still avoiding a clear succession decision.",
    "themes": ["Succession planning", "Board dynamics", "Avoidance patterns"],
    "tensions": [
        "Urgency vs. comfort with ambiguity",
        "Individual accountability vs. collective avoidance",
    ],
    "next_actions": [
        "Draft a one-page succession timeline for the committee",
        "Name the avoidance pattern directly in the next session",
    ],
}


@app.post("/api/process")
async def process_note(request: Request, file: UploadFile = File(...)):
    visitor_id = visitor_id_of(request)
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio file")

    demo = False
    try:
        async with httpx.AsyncClient() as client:
            transcript = await transcribe_audio(
                client, audio_bytes, file.filename or "note.webm", file.content_type
            )
            if not transcript.strip():
                raise ValueError("Empty transcript")
            analysis = await analyze_transcript(client, transcript)
    except Exception:
        # No key connected yet, or the call failed — fall back to a labeled demo
        # result so the interface stays usable while that gets sorted out.
        demo = True
        transcript = DEMO_TRANSCRIPT
        analysis = DEMO_RESULT

    row = _conn.execute(
        """
        INSERT INTO notes (created_at, visitor_id, transcript, summary, themes, tensions, next_actions, demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
        """,
        (
            int(time.time()),
            visitor_id,
            transcript,
            analysis.get("summary", ""),
            json.dumps(analysis.get("themes", [])),
            json.dumps(analysis.get("tensions", [])),
            json.dumps(analysis.get("next_actions", [])),
            int(demo),
        ),
    ).fetchone()
    _conn.commit()
    return _row_to_dict(row)


@app.get("/api/notes")
def list_notes(request: Request):
    visitor_id = visitor_id_of(request)
    rows = _conn.execute(
        "SELECT * FROM notes WHERE visitor_id = ? ORDER BY id DESC", (visitor_id,)
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: int, request: Request):
    visitor_id = visitor_id_of(request)
    _conn.execute(
        "DELETE FROM notes WHERE id = ? AND visitor_id = ?", (note_id, visitor_id)
    )
    _conn.commit()
    return {"deleted": note_id}


# Serve the frontend from the same process, same origin — no port placeholder needed.
app.mount("/assets", StaticFiles(directory=PUBLIC_DIR), name="assets")


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    requested = os.path.join(PUBLIC_DIR, full_path)
    if full_path and os.path.isfile(requested):
        return FileResponse(requested)
    return FileResponse(os.path.join(PUBLIC_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
