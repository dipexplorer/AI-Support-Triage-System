"""
api.py — FastAPI REST API for AI Support Triage System.

ENDPOINTS:
  GET  /                    → Web UI Dashboard
  GET  /health              → System health and corpus stats
  POST /ask                 → Triage a single ticket (JSON in, JSON out)
  POST /batch               → Triage a CSV file (CSV in, CSV out)
  GET  /history             → Recent triage decisions from SQLite
  GET  /analytics           → Aggregated statistics for charts
  GET  /corpus/companies    → List all registered corpus companies
  POST /corpus/upload       → Upload a ZIP of docs for a new company
  DELETE /corpus/{slug}     → Remove a dynamically added company
  POST /corpus/rebuild      → Force BM25 index rebuild
"""

import io
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Query
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
from retriever import get_retriever, rebuild_retriever
from agent import generate_response
from database import init_db, save_ticket, get_history, get_analytics
from corpus_manager import (
    list_companies  as cm_list,
    extract_zip_corpus,
    delete_company_corpus,
    corpus_stats,
)

# ── Global BM25 Retriever (initialized once at startup) ───────────────────────
_retriever = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Initialize DB and build the BM25 index once at server startup.
    """
    global _retriever
    # Init SQLite
    init_db()
    logger.info("✅ SQLite database initialized.")

    # Build BM25 index
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
    version="2.0.0",
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
    """Output model for /ask and /history endpoints."""
    status: str
    product_area: str
    response: str
    justification: str
    request_type: str


class HealthResponse(BaseModel):
    status: str
    corpus_domains: list[str]
    bm25_ready: bool
    total_triaged: int
    message: str


# ── Helper: process one ticket ─────────────────────────────────────────────────

def _process_one(ticket: TicketInput, source: str = "api") -> TriageResponse:
    """
    Run the full triage pipeline for a single ticket.
    Saves result to SQLite. Returns a TriageResponse.
    """
    if _retriever is None:
        raise HTTPException(status_code=503, detail="BM25 index not ready yet. Please retry.")

    # Step 1: Classify
    company      = detect_company(ticket.issue, ticket.subject, ticket.company)
    req_type     = classify_request_type(ticket.issue, ticket.subject)
    product_area = infer_product_area(ticket.issue, company)

    # Step 2: Safety Gate
    safety = safety_check(ticket.issue, ticket.subject, req_type, product_area)
    if safety.escalate or (safety.output and safety.output.status == "replied"):
        o = safety.output
        result = TriageResponse(
            status=o.status, product_area=o.product_area,
            response=o.response, justification=o.justification,
            request_type=o.request_type,
        )
    else:
        # Step 3: BM25 Retrieval
        search_company = company if company != "unknown" else None
        chunks = _retriever.retrieve(ticket.query, company=search_company)

        # Step 4: Low confidence → escalate
        if _retriever.is_low_confidence(chunks):
            reason = f"No relevant docs found (score: {_retriever.top_score(chunks):.2f})."
            o = make_escalation(reason, product_area, req_type)  # type: ignore
            result = TriageResponse(
                status=o.status, product_area=o.product_area,
                response=o.response, justification=o.justification,
                request_type=o.request_type,
            )
        else:
            # Step 5: Generate response (Gemini or Smart Fallback)
            o = generate_response(ticket, chunks, product_area, req_type)  # type: ignore
            result = TriageResponse(
                status=o.status, product_area=o.product_area,
                response=o.response, justification=o.justification,
                request_type=o.request_type,
            )

    # Persist to SQLite
    try:
        save_ticket(
            issue=ticket.issue,
            status=result.status,
            product_area=result.product_area,
            request_type=result.request_type,
            response=result.response,
            justification=result.justification,
            company=company,
            subject=ticket.subject or "",
            source=source,
        )
    except Exception as db_err:
        logger.warning(f"DB save failed (non-fatal): {db_err}")

    return result


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
def serve_ui():
    """Serve the Web UI dashboard."""
    index = WEB_DIR / "index.html"
    if not index.exists():
        return {"message": "Web UI not found. API is running — go to /docs"}
    return FileResponse(str(index))


@app.get("/health", response_model=HealthResponse, tags=["System"])
def health():
    """System health, readiness, and total tickets triaged so far."""
    from database import get_analytics
    try:
        total = get_analytics().get("total", 0)
    except Exception:
        total = 0
    return HealthResponse(
        status="ok",
        corpus_domains=COMPANIES,
        bm25_ready=_retriever is not None and getattr(_retriever, "_built", False),
        total_triaged=total,
        message="AI Support Triage System is operational.",
    )


@app.post("/ask", response_model=TriageResponse, tags=["Triage"])
def ask(ticket: TicketRequest):
    """
    Triage a **single support ticket** in real-time.
    Result is automatically saved to the history database.
    """
    input_ticket = TicketInput(
        issue=ticket.issue,
        subject=ticket.subject or "",
        company=ticket.company or "None",
    )
    try:
        return _process_one(input_ticket, source="api")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/ask error: {e}")
        raise HTTPException(status_code=500, detail=f"Internal triage error: {str(e)}")


@app.post("/batch", tags=["Triage"])
async def batch(file: UploadFile = File(...)):
    """
    Triage a **batch of tickets from a CSV file**.
    All results are saved to the history database.
    Returns a downloadable CSV.
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

    if "subject" not in df.columns: df["subject"] = ""
    if "company" not in df.columns: df["company"] = "None"

    results = []
    for _, row in df.iterrows():
        ticket = TicketInput(
            issue=str(row.get("issue", "")),
            subject=str(row.get("subject", "")),
            company=str(row.get("company", "None")),
        )
        try:
            r = _process_one(ticket, source="batch")
            results.append({
                "status": r.status, "product_area": r.product_area,
                "response": r.response, "justification": r.justification,
                "request_type": r.request_type,
            })
        except Exception as e:
            logger.error(f"Batch row error: {e}")
            results.append({
                "status": "escalated", "product_area": "general_support",
                "response": "Processing error — ticket escalated for manual review.",
                "justification": str(e), "request_type": "product_issue",
            })

    result_df = pd.concat([df, pd.DataFrame(results)], axis=1)
    output = io.StringIO()
    result_df.to_csv(output, index=False)
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=triage_output.csv"},
    )


@app.get("/history", tags=["Analytics"])
def history(
    limit: int = Query(50, ge=1, le=500, description="Max number of records to return"),
    offset: int = Query(0, ge=0),
    company: Optional[str] = Query(None, description="Filter by company name"),
):
    """
    Retrieve recent triage history from the SQLite database.
    Useful for the History tab in the UI.
    """
    try:
        rows = get_history(limit=limit, offset=offset, company=company)
        return {"total": len(rows), "records": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analytics", tags=["Analytics"])
def analytics():
    """
    Aggregated statistics for charts: status breakdown, company breakdown,
    request type distribution, daily volume, and escalation rates.
    """
    try:
        return get_analytics()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Corpus Management ───────────────────────────────────────────────────────────────

@app.get("/corpus/companies", tags=["Corpus"])
def get_companies():
    """
    List all companies in the corpus with their document counts.
    Includes both built-in companies and dynamically uploaded ones.
    """
    return corpus_stats()


@app.post("/corpus/upload", tags=["Corpus"])
async def upload_corpus(
    company_name: str = Form(..., description="Company display name, e.g. Shopify"),
    file: UploadFile = File(..., description="ZIP archive containing .md or .txt docs"),
):
    """
    Upload a ZIP of support documentation for a new company.

    After upload, call POST /corpus/rebuild to activate the new docs.

    Steps:
      1. Validates ZIP (max 50 MB, must contain .md/.txt files)
      2. Extracts into corpus/{slug}/
      3. Returns slug + doc count
      4. You MUST call /corpus/rebuild to update the BM25 index
    """
    try:
        raw = await file.read()
        result = extract_zip_corpus(raw, company_name)
        return {
            "success":   True,
            "slug":      result["slug"],
            "doc_count": result["doc_count"],
            "skipped":   result["skipped"],
            "message":   (
                f"Extracted {result['doc_count']} docs for '{result['slug']}'. "
                f"Call POST /corpus/rebuild to activate."
            ),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Corpus upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/corpus/{slug}", tags=["Corpus"])
def remove_corpus(slug: str):
    """
    Remove a dynamically added company's corpus.
    Built-in companies (hackerrank, claude, visa) cannot be removed via API.
    Call POST /corpus/rebuild after deletion to update the index.
    """
    try:
        delete_company_corpus(slug)
        return {
            "success": True,
            "message": f"Corpus for '{slug}' deleted. Call POST /corpus/rebuild to update index.",
        }
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/corpus/rebuild", tags=["Corpus"])
async def trigger_rebuild():
    """
    Rebuild the BM25 index with all current corpus documents.
    Run this after uploading new company docs or deleting a company.

    Note: Rebuilding blocks until complete (~2-5 seconds for typical corpora).
    """
    global _retriever
    try:
        import asyncio
        loop = asyncio.get_event_loop()
        # Run in thread pool to avoid blocking the async event loop
        _retriever = await loop.run_in_executor(None, rebuild_retriever)
        total_chunks = len(_retriever._chunks) if hasattr(_retriever, "_chunks") else 0
        companies    = cm_list()
        return {
            "success":       True,
            "chunks_indexed": total_chunks,
            "company_count":  len(companies),
            "companies":      [c["slug"] for c in companies],
            "message":        f"BM25 index rebuilt: {total_chunks} chunks from {len(companies)} companies.",
        }
    except Exception as e:
        logger.error(f"Corpus rebuild error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
