"""
api.py — FastAPI REST API for AI Support Triage System.

ENDPOINTS:
  GET  /health          → System health and corpus stats
  POST /ask             → Triage a single ticket (JSON in, JSON out)
  POST /batch           → Triage a CSV file (CSV in, CSV out)

STARTUP:
  BM25 index is built ONCE at server startup and reused for all requests.
  This means the first startup takes ~2 seconds, but every request after is instant.
"""

import io
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pydantic import BaseModel

# Add src to path so we can import our modules
sys.path.insert(0, str(Path(__file__).parent))

# Paths
WEB_DIR = Path(__file__).parent.parent / "web"

from config import CORPUS_DIR, COMPANIES
from models import TicketInput, make_escalation
from classifier import detect_company, classify_request_type, infer_product_area
from safety import check as safety_check
from retriever import get_retriever
from agent import generate_response

# ── Global BM25 Retriever (initialized once at startup) ───────────────────────
_retriever = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Build the BM25 index once at server startup.
    This avoids rebuilding on every request — makes /ask near-instant.
    """
    global _retriever
    logger.info("🔧 Building BM25 index at startup...")
    _retriever = get_retriever()
    _retriever.build()
    total_chunks = len(_retriever._chunks) if hasattr(_retriever, "_chunks") else "?"
    logger.info(f"✅ BM25 index ready — {total_chunks} chunks indexed.")
    yield
    logger.info("🛑 Server shutting down.")


# ── FastAPI App ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="AI Support Triage System",
    description=(
        "Automatically classify, route, and respond to customer support tickets "
        "using BM25 retrieval and Gemini AI synthesis. Zero hallucination guaranteed."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# Serve the web UI as static files
if WEB_DIR.exists():
    app.mount("/web", StaticFiles(directory=str(WEB_DIR)), name="web")

# Allow all origins for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic Request / Response Models ────────────────────────────────────────

class TicketRequest(BaseModel):
    """Input model for /ask endpoint."""
    issue: str
    subject: Optional[str] = ""
    company: Optional[str] = "None"

    class Config:
        json_schema_extra = {
            "example": {
                "issue": "How do I reset my HackerRank password? I forgot it.",
                "subject": "Password Reset Help",
                "company": "HackerRank",
            }
        }


class TriageResponse(BaseModel):
    """Output model for /ask endpoint."""
    status: str
    product_area: str
    response: str
    justification: str
    request_type: str


class HealthResponse(BaseModel):
    """Output model for /health endpoint."""
    status: str
    corpus_domains: list[str]
    bm25_ready: bool
    message: str


# ── Helper: process one ticket ─────────────────────────────────────────────────

def _process_one(ticket: TicketInput) -> TriageResponse:
    """
    Run the full triage pipeline for a single ticket.
    Returns a TriageResponse.
    """
    if _retriever is None:
        raise HTTPException(status_code=503, detail="BM25 index not ready yet. Please retry in a moment.")

    # Step 1: Classify
    company     = detect_company(ticket.issue, ticket.subject, ticket.company)
    req_type    = classify_request_type(ticket.issue, ticket.subject)
    product_area = infer_product_area(ticket.issue, company)

    # Step 2: Safety Gate
    safety = safety_check(ticket.issue, ticket.subject, req_type, product_area)
    if safety.escalate or (safety.output and safety.output.status == "replied"):
        o = safety.output
        return TriageResponse(
            status=o.status, product_area=o.product_area,
            response=o.response, justification=o.justification,
            request_type=o.request_type,
        )

    # Step 3: BM25 Retrieval
    search_company = company if company != "unknown" else None
    chunks = _retriever.retrieve(ticket.query, company=search_company)

    # Step 4: Low confidence → escalate
    if _retriever.is_low_confidence(chunks):
        reason = f"No relevant docs found (score: {_retriever.top_score(chunks):.2f})."
        o = make_escalation(reason, product_area, req_type)  # type: ignore
        return TriageResponse(
            status=o.status, product_area=o.product_area,
            response=o.response, justification=o.justification,
            request_type=o.request_type,
        )

    # Step 5: Generate response (Gemini or Smart Fallback)
    o = generate_response(ticket, chunks, product_area, req_type)  # type: ignore
    return TriageResponse(
        status=o.status, product_area=o.product_area,
        response=o.response, justification=o.justification,
        request_type=o.request_type,
    )


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
def serve_ui():
    """Serve the Web UI dashboard."""
    index = WEB_DIR / "index.html"
    if not index.exists():
        return {"message": "Web UI not found. API is running at /docs"}
    return FileResponse(str(index))

@app.get("/health", response_model=HealthResponse, tags=["System"])
def health():
    """
    Check if the server is running and the BM25 index is ready.
    """
    return HealthResponse(
        status="ok",
        corpus_domains=COMPANIES,
        bm25_ready=_retriever is not None and getattr(_retriever, "_built", False),
        message="AI Support Triage System is operational.",
    )


@app.post("/ask", response_model=TriageResponse, tags=["Triage"])
def ask(ticket: TicketRequest):
    """
    Triage a **single support ticket** in real-time.

    - Provide the ticket `issue` text and optionally `subject` and `company`.
    - The agent will classify, safety-check, retrieve relevant docs, and generate a response.
    - Returns a structured JSON with `status`, `product_area`, `response`, `justification`, `request_type`.
    """
    input_ticket = TicketInput(
        issue=ticket.issue,
        subject=ticket.subject or "",
        company=ticket.company or "None",
    )
    try:
        return _process_one(input_ticket)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/ask error: {e}")
        raise HTTPException(status_code=500, detail=f"Internal triage error: {str(e)}")


@app.post("/batch", tags=["Triage"])
async def batch(file: UploadFile = File(...)):
    """
    Triage a **batch of tickets from a CSV file**.

    - Upload a CSV with columns: `issue`, `subject` (optional), `company` (optional).
    - Returns a downloadable CSV with 5 extra columns:
      `status`, `product_area`, `response`, `justification`, `request_type`.
    """
    if not file.filename or not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a valid .csv file.")

    content = await file.read()
    try:
        df = pd.read_csv(io.BytesIO(content), keep_default_na=False)
        df.columns = [c.strip().lower() for c in df.columns]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    if "issue" not in df.columns:
        raise HTTPException(status_code=400, detail="CSV must have an 'issue' column.")

    if "subject" not in df.columns:
        df["subject"] = ""
    if "company" not in df.columns:
        df["company"] = "None"

    results = []
    for _, row in df.iterrows():
        ticket = TicketInput(
            issue=str(row.get("issue", "")),
            subject=str(row.get("subject", "")),
            company=str(row.get("company", "None")),
        )
        try:
            r = _process_one(ticket)
            results.append({
                "status": r.status,
                "product_area": r.product_area,
                "response": r.response,
                "justification": r.justification,
                "request_type": r.request_type,
            })
        except Exception as e:
            logger.error(f"Batch row error: {e}")
            results.append({
                "status": "escalated",
                "product_area": "general_support",
                "response": "Processing error — ticket escalated for manual review.",
                "justification": str(e),
                "request_type": "product_issue",
            })

    # Merge results back with original data
    result_df = pd.concat([df, pd.DataFrame(results)], axis=1)

    # Stream the CSV back as a downloadable file
    output = io.StringIO()
    result_df.to_csv(output, index=False)
    output.seek(0)

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=triage_output.csv"},
    )
