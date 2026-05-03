"""
database.py — SQLite-based persistent storage for triage history.

WHY SQLITE:
  - Zero setup: Python built-in, no external database server.
  - Single file (logs/triage.db) — easy to backup, share, or inspect.
  - Fast enough for thousands of ticket records.

SCHEMA:
  triage_history — one row per triaged ticket.
"""

import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from config import LOG_DIR

DB_PATH = LOG_DIR / "triage.db"

# Thread-safe lock for concurrent API requests
_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    """Open a connection with row_factory for dict-like access."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """
    Create the database and tables if they don't exist.
    Safe to call multiple times (idempotent).
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with _lock, _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS triage_history (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp    TEXT    NOT NULL,
                source       TEXT    NOT NULL DEFAULT 'api',
                company      TEXT    NOT NULL DEFAULT 'unknown',
                subject      TEXT,
                issue        TEXT    NOT NULL,
                status       TEXT    NOT NULL,
                product_area TEXT    NOT NULL,
                request_type TEXT    NOT NULL,
                response     TEXT    NOT NULL,
                justification TEXT   NOT NULL
            )
        """)
        conn.commit()


def save_ticket(
    issue: str,
    status: str,
    product_area: str,
    request_type: str,
    response: str,
    justification: str,
    company: str = "unknown",
    subject: str = "",
    source: str = "api",          # 'api' (single) or 'batch' (CSV upload)
) -> int:
    """
    Insert one triage result into the database.
    Returns the new row's id.
    """
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    with _lock, _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO triage_history
              (timestamp, source, company, subject, issue,
               status, product_area, request_type, response, justification)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (ts, source, company, subject, issue,
             status, product_area, request_type, response, justification),
        )
        conn.commit()
        return cur.lastrowid or 0


def get_history(limit: int = 50, offset: int = 0, company: Optional[str] = None) -> list[dict]:
    """
    Fetch recent triage history, newest first.
    Optionally filter by company.
    """
    with _lock, _connect() as conn:
        if company:
            rows = conn.execute(
                """
                SELECT * FROM triage_history
                WHERE lower(company) = lower(?)
                ORDER BY id DESC LIMIT ? OFFSET ?
                """,
                (company, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM triage_history
                ORDER BY id DESC LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]


def get_analytics() -> dict:
    """
    Return aggregated statistics for the Analytics tab.
    """
    with _lock, _connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM triage_history").fetchone()[0]

        # Status breakdown
        status_rows = conn.execute(
            "SELECT status, COUNT(*) as cnt FROM triage_history GROUP BY status"
        ).fetchall()
        status_counts = {r["status"]: r["cnt"] for r in status_rows}

        # Company breakdown
        company_rows = conn.execute(
            "SELECT company, COUNT(*) as cnt FROM triage_history GROUP BY company ORDER BY cnt DESC"
        ).fetchall()
        company_counts = {r["company"]: r["cnt"] for r in company_rows}

        # Request type breakdown
        type_rows = conn.execute(
            "SELECT request_type, COUNT(*) as cnt FROM triage_history GROUP BY request_type ORDER BY cnt DESC"
        ).fetchall()
        type_counts = {r["request_type"]: r["cnt"] for r in type_rows}

        # Daily volume (last 14 days)
        daily_rows = conn.execute(
            """
            SELECT substr(timestamp, 1, 10) as day, COUNT(*) as cnt
            FROM triage_history
            WHERE timestamp >= date('now', '-14 days')
            GROUP BY day ORDER BY day
            """
        ).fetchall()
        daily_volume = [{"day": r["day"], "count": r["cnt"]} for r in daily_rows]

        # Escalation rate per company
        escalation_rows = conn.execute(
            """
            SELECT company,
                   COUNT(*) as total,
                   SUM(CASE WHEN status='escalated' THEN 1 ELSE 0 END) as escalated
            FROM triage_history GROUP BY company
            """
        ).fetchall()
        escalation_by_company = [
            {
                "company": r["company"],
                "total": r["total"],
                "escalated": r["escalated"],
                "rate": round(r["escalated"] / r["total"] * 100, 1) if r["total"] else 0,
            }
            for r in escalation_rows
        ]

    return {
        "total": total,
        "status_counts": status_counts,
        "company_counts": company_counts,
        "request_type_counts": type_counts,
        "daily_volume": daily_volume,
        "escalation_by_company": escalation_by_company,
    }
