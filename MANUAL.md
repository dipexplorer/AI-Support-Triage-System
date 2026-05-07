# 📘 AI Support Triage System — User & Admin Manual

Welcome to the **AI Support Triage System**. This system is designed to automate the first line of customer support, helping your team focus on complex issues while the AI handles routine queries, classification, and routing.

---

## 🎯 What is this System? (Target User POV)

This system is built for **Support Managers** and **Internal Operations Teams**. It is **not** a direct customer-facing app; instead, it works behind the scenes to:
1.  **Auto-Reply**: Grounded in your company's actual documentation.
2.  **Classify**: Identify if a ticket is a bug, billing issue, or feature request.
3.  **Route/Escalate**: Instantly flag high-risk or complex tickets for human review.

---

## 🚀 Deployment Guide (Admin/Developer)

The easiest way to run the system is using **Docker**. This ensures all dependencies and environment settings are correctly configured.

### 1. Requirements
- Docker and Docker Compose installed.
- A Gemini API Key (Optional, but recommended for smarter AI responses).

### 2. One-Command Setup
Open your terminal in the project directory and run:
```bash
docker compose up -d
```
The system will be live at: `http://localhost:8000`

### 3. Persistent Data
The system automatically saves your data outside the container:
- **`logs/`**: Contains the `triage.db` (History and Feedback).
- **`corpus/`**: Contains all your uploaded support documents.
*Even if you stop or update the container, your data remains safe.*

---

## 🖥️ Dashboard Walkthrough

### 1. Single Ticket (Real-time Mode)
- **Use Case**: Quickly testing the AI's response to a specific query.
- **How to use**: Type the customer's issue, select the company, and click "Triage Ticket".
- **Feedback**: Use the 👍 or 👎 buttons below the result to help improve the model.

### 2. Batch CSV (Bulk Processing)
- **Use Case**: Processing a day's worth of tickets (e.g., 500 tickets) at once.
- **How to use**: Drag and drop a CSV file (Schema: `issue`, `company`, `subject`).
- **Result**: Download a processed CSV with classification and AI responses.

### 3. Corpus Management
- **Use Case**: Updating the AI's knowledge base.
- **How to use**: Upload a `.zip` file containing Markdown (`.md`) or text (`.txt`) files.
- **How it works**: The AI will instantly "read" these files and use them to ground its next responses. No retraining required!

### 4. Analytics & Feedback
- **Use Case**: Monitoring system performance.
- **Approval Rate**: See what percentage of AI responses were marked helpful by staff.
- **Low-Rated Review**: Review a dedicated table of tickets that received negative feedback to identify gaps in your documentation.

---

## 🛠️ Maintenance & Troubleshooting

### Updating Documentation
To teach the AI something new:
1.  Go to the **Corpus** tab.
2.  Upload the updated docs.
3.  The system automatically re-indexes them.

### Resetting the Server
If you need to restart the system:
```bash
docker compose restart
```

### Viewing Logs
To see what's happening under the hood:
```bash
docker compose logs -f
```

---

## 🔒 Security Notice
Currently, the dashboard is open to anyone with the URL. For production use, please ensure you are running this behind a VPN or wait for **Phase 7 (Authentication)** implementation.
