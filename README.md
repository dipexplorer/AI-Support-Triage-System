# AI Support Triage System

A production-ready, multi-domain support ticket triage agent that intelligently classifies, routes, and responds to customer support tickets using a **Hybrid BM25 + Gemini AI** pipeline.

## ✨ Features

- **Multi-Domain Support** — Handles tickets across multiple product domains simultaneously
- **Hybrid AI Pipeline** — BM25 fast retrieval + Gemini LLM synthesis for intelligent, grounded responses
- **Zero Hallucination** — Responses are always grounded in your own support corpus; agent escalates when it doesn't know
- **Safety Firewall** — Detects and blocks prompt injections, malicious commands, and high-risk fraud requests before they reach the AI
- **Fail-Safe Fallback** — If the LLM API is unavailable, the system seamlessly falls back to a smart deterministic BM25 response
- **Structured Audit Logs** — Every triage decision is logged with reasoning, confidence score, and company context
- **Strict Schema Validation** — Pydantic ensures every output matches the exact required schema

## 🏗️ Architecture

```
Input CSV → Classifier → Safety Gate → BM25 Retriever → Gemini Synthesizer → Output CSV
                              ↓                 ↓                  ↓
                         Escalate        Escalate (low        Smart Fallback
                        (high risk)       confidence)         (API offline)
```

### Module Breakdown

| Module | Role |
|---|---|
| `src/main.py` | Orchestrator — reads input, runs the full pipeline, writes output |
| `src/classifier.py` | Detects company/domain and request type using keyword matching |
| `src/safety.py` | Deterministic firewall — blocks injections, fraud, malicious inputs |
| `src/retriever.py` | BM25 Okapi search engine — indexes corpus and retrieves top-K chunks |
| `src/agent.py` | Hybrid brain — tries Gemini first, falls back to smart BM25 format |
| `src/models.py` | Pydantic schemas for input, output, and retrieved documents |
| `src/config.py` | Central config — all paths, thresholds, and keyword lists |
| `src/logger.py` | Structured audit logging for every triage decision |

## 📁 Project Structure

```
AI-Support-Triage-System/
├── src/                    # Core agent source code
│   ├── main.py
│   ├── agent.py
│   ├── classifier.py
│   ├── config.py
│   ├── logger.py
│   ├── models.py
│   ├── retriever.py
│   ├── safety.py
│   └── requirements.txt
├── corpus/                 # Support documentation corpus
│   ├── hackerrank/
│   ├── claude/
│   └── visa/
├── tickets/
│   ├── input/              # Input CSV files
│   │   └── tickets.csv
│   └── output/             # Generated output
│       └── output.csv
├── logs/                   # Triage audit logs
├── docs/                   # Architecture and design docs
├── .env.example
└── README.md
```

## 🚀 Quick Start

### 1. Clone and Setup

```bash
git clone git@github.com:dipexplorer/AI-Support-Triage-System.git
cd AI-Support-Triage-System
python -m venv .venv
source .venv/bin/activate
pip install -r src/requirements.txt
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```

### 3. Add Your Corpus

Place your support documentation (`.md`, `.txt`, `.html` files) in the `corpus/` directory. Organize by domain:

```
corpus/
├── your-product-1/
│   ├── faq.md
│   └── billing.md
└── your-product-2/
    └── getting-started.md
```

### 4. Run

```bash
# Run on your tickets
python src/main.py

# Run on a sample file
python src/main.py --sample

# Custom input/output paths
python src/main.py --input tickets/input/my_tickets.csv --output tickets/output/results.csv
```

## 📊 Input / Output Schema

### Input CSV (`tickets/input/tickets.csv`)

| Column | Description |
|---|---|
| `issue` | The main ticket body or question |
| `subject` | Optional subject line (can be blank or noisy) |
| `company` | Domain name or `None` for auto-detection |

### Output CSV (`tickets/output/output.csv`)

| Column | Values | Description |
|---|---|---|
| `status` | `replied` / `escalated` | Whether the agent answered or routed to human |
| `product_area` | string | Support category (e.g., `billing`, `general_support`) |
| `response` | string | User-facing response grounded in the corpus |
| `justification` | string | Internal reasoning for the decision |
| `request_type` | `product_issue` / `feature_request` / `bug` / `invalid` | Classification |

## ⚙️ Configuration

All tunable parameters are in `src/config.py`:

```python
TOP_K_DOCS       = 5      # chunks retrieved per query
MIN_BM25_SCORE   = 1.0    # escalate if best score is below this
CHUNK_SIZE_WORDS = 250     # corpus chunk size in words
```

To add a new supported domain, add it to `COMPANIES` and `COMPANY_KEYWORDS` in `config.py`.

## 🔒 Safety Features

The safety module (`src/safety.py`) runs **before** any AI processing:

- **Prompt Injection Detection** — Blocks "ignore previous instructions", jailbreak attempts
- **Malicious Command Detection** — Blocks `rm -rf`, `DROP TABLE`, etc.
- **High-Risk Keyword Escalation** — Auto-escalates fraud, account compromise, financial distress
- **Language/Unicode Abuse Detection** — Flags suspicious encoding patterns

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Retrieval | `rank-bm25` (BM25 Okapi) |
| LLM Synthesis | Google Gemini 2.0 Flash (optional) |
| Data Validation | Pydantic v2 |
| Data Processing | pandas |
| Logging | loguru |
| CLI Progress | rich |

## 📜 License

MIT License — free to use, modify, and distribute.