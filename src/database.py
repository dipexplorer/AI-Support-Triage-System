"""
database.py — SQLite-based persistent storage for triage history and feedback.

WHY SQLITE:
  - Zero setup: Python built-in, no external database server.
  - Single file (logs/triage.db) — easy to backup, share, or inspect.
  - Fast enough for thousands of ticket records.

SCHEMA:
  triage_history — one row per triaged ticket.
  feedback       — one row per thumbs-up/down rating on a ticket.
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
    conn.execute("PRAGMA foreign_keys = ON")
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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id   INTEGER NOT NULL REFERENCES triage_history(id) ON DELETE CASCADE,
                rating      INTEGER NOT NULL CHECK(rating IN (1, -1)),
                comment     TEXT    DEFAULT '',
                timestamp   TEXT    NOT NULL
            )
        """)
        # Index for fast lookup by ticket_id
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_feedback_ticket
            ON feedback(ticket_id)
        """)
        conn.commit()


# ── Triage History ─────────────────────────────────────────────────────────────

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
    Includes feedback rating per ticket (if any).
    """
    with _lock, _connect() as conn:
        base_sql = """
            SELECT h.*,
                   f.rating     AS feedback_rating,
                   f.comment    AS feedback_comment,
                   f.timestamp  AS feedback_time
            FROM triage_history h
            LEFT JOIN feedback f ON f.ticket_id = h.id
        """
        if company:
            rows = conn.execute(
                base_sql + " WHERE lower(h.company) = lower(?) ORDER BY h.id DESC LIMIT ? OFFSET ?",
                (company, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                base_sql + " ORDER BY h.id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]


# ── Feedback ───────────────────────────────────────────────────────────────────

def save_feedback(ticket_id: int, rating: int, comment: str = "") -> int:
    """
    Insert or replace a feedback rating for a given ticket.
    rating: +1 = thumbs up, -1 = thumbs down.
    Returns the feedback row id.
    """
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    with _lock, _connect() as conn:
        # Delete existing feedback for this ticket (one rating per ticket)
        conn.execute("DELETE FROM feedback WHERE ticket_id = ?", (ticket_id,))
        cur = conn.execute(
            "INSERT INTO feedback (ticket_id, rating, comment, timestamp) VALUES (?, ?, ?, ?)",
            (ticket_id, rating, comment, ts),
        )
        conn.commit()
        return cur.lastrowid or 0


def get_feedback_summary() -> dict:
    """
    Aggregate feedback statistics.
    Returns approval rate, total rated, and low-rated ticket IDs.
    """
    with _lock, _connect() as conn:
        total_rated = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        positive    = conn.execute("SELECT COUNT(*) FROM feedback WHERE rating = 1").fetchone()[0]
        negative    = conn.execute("SELECT COUNT(*) FROM feedback WHERE rating = -1").fetchone()[0]

        approval_rate = round(positive / total_rated * 100, 1) if total_rated else 0

        # Low-rated tickets — full record for review
        low_rated = conn.execute("""
            SELECT h.id, h.company, h.issue, h.status, h.request_type,
                   h.response, h.timestamp, f.comment
            FROM triage_history h
            JOIN feedback f ON f.ticket_id = h.id
            WHERE f.rating = -1
            ORDER BY h.id DESC
            LIMIT 20
        """).fetchall()

        # Feedback breakdown by company
        by_company = conn.execute("""
            SELECT h.company,
                   COUNT(*) as total_rated,
                   SUM(CASE WHEN f.rating = 1 THEN 1 ELSE 0 END) as positive,
                   SUM(CASE WHEN f.rating = -1 THEN 1 ELSE 0 END) as negative
            FROM feedback f
            JOIN triage_history h ON h.id = f.ticket_id
            GROUP BY h.company
        """).fetchall()

    return {
        "total_rated":    total_rated,
        "positive":       positive,
        "negative":       negative,
        "approval_rate":  approval_rate,
        "low_rated":      [dict(r) for r in low_rated],
        "by_company":     [dict(r) for r in by_company],
    }


# ── Analytics ─────────────────────────────────────────────────────────────────

def get_analytics() -> dict:
    """
    Return aggregated statistics for the Analytics tab.
    Now includes feedback approval rate.
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
                "company":   r["company"],
                "total":     r["total"],
                "escalated": r["escalated"],
                "rate":      round(r["escalated"] / r["total"] * 100, 1) if r["total"] else 0,
            }
            for r in escalation_rows
        ]

        # Feedback approval rate
        total_rated  = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        positive_fb  = conn.execute("SELECT COUNT(*) FROM feedback WHERE rating = 1").fetchone()[0]
        approval_rate = round(positive_fb / total_rated * 100, 1) if total_rated else None

    return {
        "total":                total,
        "status_counts":        status_counts,
        "company_counts":       company_counts,
        "request_type_counts":  type_counts,
        "daily_volume":         daily_volume,
        "escalation_by_company": escalation_by_company,
        "feedback": {
            "total_rated":    total_rated,
            "positive":       positive_fb,
            "approval_rate":  approval_rate,
        },
    }
