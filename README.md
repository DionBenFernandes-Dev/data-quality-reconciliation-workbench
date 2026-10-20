# Data Quality & Reconciliation Workbench

A local-first web app for repeatable, explainable comparison of two synthetic or user-provided CSV/Excel datasets. It is designed to surface differences for review, not silently clean or overwrite the source files.

**Current release:** MVP source package, version `0.1.0`  
**Stack:** Python · pandas · FastAPI · SQLite · React · Vite  
**Primary workflow:** Upload Source A and Source B → choose matching keys → choose comparison fields and normalization rules → run checks → inspect exceptions → export CSV/Excel or save a rule profile.

## Implemented

- Upload CSV, XLSX, and XLSM files; inspect columns, row counts, inferred types, missing-cell counts, and sample rows.
- Select a worksheet in multi-sheet Excel workbooks.
- Configure one or more matching-key pairs, including differently named columns and composite keys.
- Compare same-named non-key columns using deterministic equality checks and an optional absolute numeric tolerance.
- Normalize surrounding whitespace; optionally ignore letter case.
- Flag duplicate keys, exact duplicate rows, missing matching keys, missing cell values, missing records, and row-level value mismatches.
- Treat duplicate keys as ambiguous: do not automatically pair those rows.
- Optional fuzzy suggestions (confidence threshold configurable). Suggestions are informational and do **not** alter exact matching counts or auto-merge records.
- Paginated and searchable exception register, filtering by exception type, and an applied-rules view.
- CSV exception export and XLSX report export with a Summary and Exceptions worksheet.
- Saved rule profiles, run history, and an operational audit log in SQLite.
- Remove stored upload copies while preserving previously saved run results. The original file at its original location is never modified.
- Synthetic sample datasets so the first run can be explored without preparing files.
- Unit and API integration tests.

## Requirements

- Python 3.11 or newer recommended (tested in this workspace on Python 3.13).
- Node.js 20 or newer and npm.
- A modern browser.

## Quick start on Linux / macOS

From the project root:

```bash
./setup.sh
./run-dev.sh
```

Open the Vite URL printed by the terminal (normally `http://127.0.0.1:5173`). The API runs at `http://127.0.0.1:8000`; interactive API documentation is available at `http://127.0.0.1:8000/docs`.

To start the services separately:

```bash
# Terminal 1 — backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000

# Terminal 2 — frontend
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

On Windows, create a virtual environment with `py -m venv .venv`, activate `.venv\Scripts\activate`, install `backend\requirements.txt`, and run `py -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000`. In a second terminal run `cd frontend`, `npm install`, and `npm run dev`.

## First run

1. Start both services.
2. Click **Load demo data**.
3. Confirm `account_id` is selected as the matching key and inspect the proposed comparison fields.
4. Click **Run reconciliation**.
5. Inspect the exception register, filter by exception type, and try the **Applied rules** tab.
6. Use **Export report** to download an XLSX workbook or CSV exception list.
7. Use **Save rules** to persist a reusable profile. Reopen prior runs under **Run history**.

The demo intentionally includes a duplicated key, missing values/records, changed values, and a near-match that can be suggested by fuzzy matching.

## Data behavior and definitions

### Matching

- Matching is exact by default after the selected key normalization options.
- A record is automatically paired only when its normalized key occurs exactly once in each dataset.
- Composite keys require all selected key fields to be present.
- Rows with missing key fields are flagged and excluded from matching.
- Duplicate-key groups are flagged as ambiguous; the engine does not choose an arbitrary row or expand into a many-to-many join.
- Fuzzy matching checks unmatched rows only, requires one matching key, and returns a confidence-ranked suggestion. It never updates the exact result classification.

### Value comparisons

- The UI suggests exact-name, non-key columns from both datasets; users can choose which suggested fields to compare.
- Comparison options are trim whitespace, case-insensitive comparison, and an absolute numeric tolerance.
- A positive numeric tolerance enables numeric parsing for compared values; both values must parse as finite numbers to use it. Non-numeric values fall back to normalized text equality. With zero tolerance, text-valued CSV cells are compared as text, preserving distinctions such as `00100` versus `100`.
- Missing cell values are reported separately. If either side of a compared field is missing, the blank-cell exception is the primary signal rather than a duplicate value-mismatch exception.
- A value mismatch is reported per matched record and compared field. A matched record may therefore have multiple mismatches.
- Row references are 1-based data-row numbers plus one header row (the first data record is row 2); they are display references, not guaranteed physical text-file line offsets for CSV files with embedded newlines.

### Exception volume

The engine limits individually stored exception details to 200,000 per run to protect local memory and storage. Counts of additional omitted details are made explicit in the summary and a warning/summary exception is emitted. A run that reaches this limit is not a complete row-by-row export of all exceptions; reduce the dataset or split the work if full detail is needed.

### Supported formats and limits

- `.csv`, `.xlsx`, `.xlsm` are supported. Legacy `.xls` is not supported by this release.
- File size is limited to 50 MB per upload.
- A maximum of 250,000 data rows per file is supported in this MVP. Actual practical limits depend on column count and available RAM.
- The first worksheet is selected by default; another worksheet can be selected in the UI.
- CSV is read with delimiter sniffing and identifier-preserving string import; Excel cells are read using their stored values.
- Blank column names and duplicate column names (ignoring case) are rejected before reconciliation.

## Storage, privacy, and security

- The backend binds to `127.0.0.1` by default. It does not require a cloud account and does not send datasets to an AI service.
- Upload copies, the SQLite database, saved profiles, and run results live in `backend/data/` by default. Set `DQW_DATA_DIR` to choose a different location.
- Removing a dataset from the UI deletes only the workbench's saved copy; the original file stays unchanged. Existing run metadata and exceptions remain available.
- Audit records store operational metadata (file names, event types, counts, and IDs), not raw cell values. Exception results and exported reports can contain cell values from source files.
- **This version is a single-user, local-development application. Authentication, authorization, multi-user tenancy, and automated retention/deletion policies are not implemented. Do not expose it to a company LAN or the public internet, and do not use regulated/confidential data, until your security review and deployment controls are in place.** Restrict filesystem access to the local user.
- The app limits input size/row count and validates extensions/headers. Dependencies should be pinned and scanned before production deployment.
- CSV export prefixes formula-like cell strings to reduce spreadsheet formula injection risk. XLSX string cells are written as text.

## Project layout

```text
data-quality-reconciliation-workbench/
├── backend/
│   ├── app/
│   │   ├── engine.py          # matching, quality rules, and exception explanation
│   │   └── main.py            # FastAPI endpoints, local persistence, exports
│   ├── sample_data/           # synthetic Source A / Source B CSVs
│   ├── tests/                 # deterministic engine and API tests
│   └── requirements.txt
├── frontend/
│   ├── src/App.jsx            # workspace, profiles, history, exception register
│   ├── src/api.js             # API client and report download
│   ├── src/styles.css         # responsive design system
│   └── package.json
├── docs/IMPLEMENTATION_NOTES.md
├── setup.sh
└── run-dev.sh
```

## Tests and build validation

```bash
# Backend test suite
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest -q

# Frontend production build
cd ../frontend
npm install
npm run build
```

## API outline

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/uploads` | Upload and inspect a file |
| `PATCH` | `/api/uploads/{id}/sheet` | Switch worksheet |
| `DELETE` | `/api/uploads/{id}` | Remove the workbench's source copy |
| `POST` | `/api/demo` | Load both synthetic datasets |
| `POST` | `/api/reconciliations` | Run deterministic checks and record exceptions |
| `GET` | `/api/runs` | List recent runs |
| `GET` | `/api/runs/{id}` | Read a run and page/filter exceptions |
| `GET` | `/api/runs/{id}/export?format=csv\|xlsx` | Download exceptions/report |
| `GET`, `POST` | `/api/profiles` | List or save rule profiles |
| `DELETE` | `/api/profiles/{id}` | Delete a profile |
| `GET` | `/api/audit` | Read operational audit events |

Interactive request/response schemas are available through FastAPI's `/docs` page when the backend is running.

## Release status

This package is a **runnable MVP / development build**, not a production-approved release. The data engine, persistence, profile/history workflows, and exports are implemented; tests and local build checks are part of verification. Production rollout still requires authentication and authorization if shared, retention controls, load/performance testing on representative files, threat modeling, accessibility testing with target users, and deployment-specific logging/backup decisions.
