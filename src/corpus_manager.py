"""
corpus_manager.py — Dynamic Corpus Management.

Allows ANY company to add their support documentation at runtime.

FLOW:
  1. Admin uploads ZIP file containing .md/.txt docs
  2. ZIP extracted into corpus/{company_slug}/
  3. BM25 index rebuilt (hot-reload — no server restart needed)
  4. Classifier auto-detects new company from corpus dir scan

DESIGN DECISIONS:
  - ZIP format chosen because it's universal and preserves folder structure
  - Files flattened into company dir (nested folders are fine, rglob handles it)
  - company_slug = lowercase alphanumeric, underscores (URL safe)
  - Built-in companies (hackerrank, claude, visa) cannot be deleted via API
"""

import io
import re
import shutil
import zipfile
from pathlib import Path

from loguru import logger

from config import COMPANIES as DEFAULT_COMPANIES, CORPUS_DIR

# Allowed doc extensions
ALLOWED_EXTENSIONS = {".md", ".txt"}

# Max ZIP upload size (50 MB)
MAX_ZIP_BYTES = 50 * 1024 * 1024


# ── Slug helper ───────────────────────────────────────────────────────────────

def slugify(name: str) -> str:
    """
    Convert company name to a safe directory slug.
    'My Company Name' → 'my_company_name'
    'Stripe Inc.' → 'stripe_inc'
    """
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9\s_-]", "", s)       # keep alphanumeric + spaces + _ -
    s = re.sub(r"[\s\-]+", "_", s)             # spaces/hyphens → underscore
    s = re.sub(r"_+", "_", s).strip("_")       # collapse multiple underscores
    return s or "unknown"


# ── Company listing ───────────────────────────────────────────────────────────

def list_companies() -> list[dict]:
    """
    Scan corpus/ and return metadata for every registered company.

    Returns list of:
    {
        "slug":         "hackerrank",
        "display_name": "Hackerrank",
        "doc_count":    438,
        "is_default":   True,
    }
    """
    if not CORPUS_DIR.exists():
        return []

    result = []
    for company_dir in sorted(CORPUS_DIR.iterdir()):
        if not company_dir.is_dir():
            continue
        slug = company_dir.name
        files = [
            f for f in company_dir.rglob("*")
            if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS
        ]
        result.append({
            "slug":         slug,
            "display_name": slug.replace("_", " ").title(),
            "doc_count":    len(files),
            "is_default":   slug in DEFAULT_COMPANIES,
        })
    return result


# ── Upload & Extract ──────────────────────────────────────────────────────────

def extract_zip_corpus(zip_bytes: bytes, company_name: str) -> dict:
    """
    Extract a ZIP file of support docs into corpus/{slug}/.

    Args:
        zip_bytes:    Raw bytes of the uploaded ZIP
        company_name: Human-readable company name (e.g. "Shopify")

    Returns:
        {
            "slug":      "shopify",
            "doc_count": 42,
            "skipped":   3,    # non-allowed extensions
        }

    Raises:
        ValueError: If ZIP is invalid, too large, or has no valid docs
    """
    if len(zip_bytes) > MAX_ZIP_BYTES:
        raise ValueError(f"ZIP too large: {len(zip_bytes)//1024//1024} MB (max 50 MB)")

    slug = slugify(company_name)
    if not slug:
        raise ValueError("Company name produced empty slug — please use alphanumeric characters.")

    target_dir = CORPUS_DIR / slug

    # Validate ZIP before touching filesystem
    if not zipfile.is_zipfile(io.BytesIO(zip_bytes)):
        raise ValueError("Uploaded file is not a valid ZIP archive.")

    # Clean existing folder (allow re-upload / update)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    doc_count = 0
    skipped   = 0

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for member in zf.namelist():
            # Skip directories and hidden files
            if member.endswith("/") or Path(member).name.startswith("."):
                continue

            suffix = Path(member).suffix.lower()
            if suffix not in ALLOWED_EXTENSIONS:
                skipped += 1
                continue

            # Flatten: keep basename only (avoid deep nesting)
            filename = Path(member).name
            if not filename:
                continue

            content = zf.read(member)
            if len(content.strip()) < 30:   # skip near-empty files
                skipped += 1
                continue

            # If filename conflicts, prefix with index
            dest = target_dir / filename
            if dest.exists():
                dest = target_dir / f"{doc_count}_{filename}"

            dest.write_bytes(content)
            doc_count += 1

    if doc_count == 0:
        # Roll back: remove empty folder
        shutil.rmtree(target_dir, ignore_errors=True)
        raise ValueError(
            f"ZIP contained no valid docs (.md/.txt). "
            f"Skipped {skipped} files with unsupported extensions."
        )

    logger.info(f"Corpus uploaded: '{slug}' — {doc_count} docs extracted, {skipped} skipped.")
    return {
        "slug":      slug,
        "doc_count": doc_count,
        "skipped":   skipped,
    }


# ── Delete ────────────────────────────────────────────────────────────────────

def delete_company_corpus(slug: str) -> bool:
    """
    Remove a dynamically added company's corpus directory.

    Raises:
        ValueError: If company is a built-in default (cannot be deleted via API)
        FileNotFoundError: If company directory doesn't exist
    """
    if slug in DEFAULT_COMPANIES:
        raise ValueError(
            f"'{slug}' is a built-in company and cannot be deleted via the UI. "
            f"Remove its folder manually from corpus/ if needed."
        )

    target_dir = CORPUS_DIR / slug
    if not target_dir.exists():
        raise FileNotFoundError(f"Company '{slug}' not found in corpus/.")

    shutil.rmtree(target_dir)
    logger.info(f"Corpus deleted: '{slug}'")
    return True


# ── Stats ─────────────────────────────────────────────────────────────────────

def corpus_stats() -> dict:
    """
    Return overall corpus statistics.
    """
    companies  = list_companies()
    total_docs = sum(c["doc_count"] for c in companies)
    return {
        "company_count": len(companies),
        "total_docs":    total_docs,
        "companies":     companies,
    }
