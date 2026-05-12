# 🏥 Silent Deterioration Monitor
### Healthcare AI MCP Server · A2A Agent · FHIR R4 · SHARP Context Propagation · NEWS2

> **"Patients don't deteriorate loudly. They drift — one borderline vital at a time — until it's too late. This system catches the drift."**

*Built for Agents Assemble — The Healthcare AI Endgame · Prompt Opinion Hackathon 2026*

---

## 🏆 Judging Criteria Alignment

### The AI Factor
Traditional EWS (Early Warning Systems) use simple thresholds: *if HR > 100, alert*. This system detects **multi-parameter deterioration patterns** that are individually borderline but collectively alarming — exactly what busy clinicians miss:

| Pattern | Parameters | What Rule-Based Misses |
|---------|-----------|------------------------|
| Sepsis Triad | HR + RR + WBC + CRP | Each borderline alone; together = SIRS |
| Cardiorenal Syndrome | SBP + Creatinine | Organ coupling not detectable by threshold |
| Respiratory-Hemodynamic | SpO2 + RR + HR | Compensation phase before decompensation |

The **Groq LLM layer** generates differential diagnoses, urgency justification, and clinical narrative from raw signal data — not possible with rules.

### Potential Impact
- **Problem**: Sepsis causes 270,000 US deaths/year. 80% are preventable with early detection.
- **Gap**: Rule-based EWS generate 50–99% false positives → alert fatigue → ignored alerts.
- **Hypothesis**: Multi-parameter AI detection catches combined signals 2–4 hours before threshold-based systems trigger.

### Feasibility
- **FHIR R4**: HL7 standard adopted by Epic, Cerner, and all major EHRs
- **NEWS2**: NHS-validated across 250,000+ patients, endorsed by NICE
- **SHARP context**: Enables SMART-on-FHIR token propagation in production
- No proprietary data formats — pure open standards
- Graceful degradation: works without LLM, works without live FHIR
- Strictly synthetic/de-identified data — no PHI

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FHIR R4 SERVER                           │
│             (HAPI sandbox / Epic / Cerner)                  │
│         Patient · Observation · Condition                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ FHIR REST API
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              SILENT DETERIORATION MCP SERVER                │
│                                                             │
│  Tool 1: get_patient_vitals        → FHIR Observations      │
│  Tool 2: get_lab_results           → FHIR Lab Observations  │
│  Tool 3: assess_deterioration_risk → NEWS2 + AI Patterns    │
│  Tool 4: scan_ward_for_deterioration → Multi-patient rank   │
│  Tool 5: build_sharp_context       → A2A envelope builder   │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ fhirClient  │  │  riskEngine  │  │   llmAnalyzer    │   │
│  │  FHIR R4    │  │ NEWS2+Patterns│  │   Grok API       │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│                        ┌──────────────────┐                 │
│                        │  sharpAdapter    │                 │
│                        │  SHARP Envelope  │                 │
│                        └──────────────────┘                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ MCP Protocol (stdio/HTTP)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│            PROMPT OPINION PLATFORM                          │
│                                                             │
│  A2A Agent: "Silent Deterioration Monitor"                  │
│  - Receives natural language queries                        │
│  - Calls MCP tools via COIN protocol                        │
│  - Propagates SHARP context to downstream agents            │
│  - Returns structured clinical alerts                       │
└─────────────────────────────────────────────────────────────┘
                       │ SHARP Context (A2A chain)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│           DOWNSTREAM AGENTS (A2A chain)                     │
│  · Medication Safety Agent  · Notification Agent            │
│  · Documentation Agent      · Escalation Agent              │
└─────────────────────────────────────────────────────────────┘
```
---

## 🛠️ MCP Tools

| Tool | Description |
|------|-------------|
| `get_patient_vitals` | Fetches HR, BP, SpO2, RR, Temp via FHIR Observations |
| `get_lab_results` | Fetches creatinine, K+, WBC, CRP, Hgb via FHIR Labs |
| `assess_deterioration_risk` | Full AI assessment with NEWS2 scoring + SHARP envelope |
| `scan_ward_for_deterioration` | Multi-patient priority ranking across a ward |
| `build_sharp_context` | Builds A2A-ready SHARP context envelope |

---

## 🔬 Clinical Intelligence

### NEWS2 Scoring
NHS gold standard, validated across 250,000+ patient episodes. Scores: Respiratory Rate, SpO2, Systolic BP, Heart Rate, Temperature.

### Groq LLM Integration (llama-3.3-70b-versatile)
- Clinical narrative generation
- Differential diagnosis ranking
- Urgency justification
- Recommended next steps
- Graceful fallback if API unavailable

### SHARP Context Envelope
Each risk assessment produces a **SHARP envelope**:

```json
{
  "specVersion": "1.0",
  "contextType": "deterioration-alert",
  "patientRef": { "resourceType": "Patient", "fhirBaseUrl": "..." },
  "clinicalPayload": { "severity": "CRITICAL", "crossPatternAlerts": [] },
  "agentChain": [{ "agentId": "silent-deterioration-mcp-v1" }],
  "propagationRules": { "forwardToAgents": true, "requiresAcknowledgment": true }
}
```
This flows through any downstream A2A agent chain on Prompt Opinion without re-authentication or re-fetching.

---

## 🚀 Setup

```bash
cd mcp-server
npm install
cp .env.example .env
# Add GROQ_API_KEY 

npx tsc
node dist/index.js
```

Open `dashboard/index.html` in browser. Click **SCAN WARD** to see all 4 demo patients.

### Prompt Opinion Marketplace

To connect to the Prompt Opinion platform, expose the server via HTTP:

```bash
# Run with HTTP transport on port 3001
node dist/index.js --http --port 3001

# Expose publicly (development)
D:\ngrok.exe http 3001
```

Register the tunnel URL as your MCP endpoint in the Prompt Opinion marketplace.

---

## 📁 Project Structure
```
silent-deterioration/
├── mcp-server/
│   ├── src/
│   │   ├── index.ts          # MCP server + 5 tools
│   │   ├── fhirClient.ts     # FHIR R4 data fetching
│   │   ├── riskEngine.ts     # NEWS2 + pattern detection
│   │   ├── llmAnalyzer.ts    # Groq LLM enrichment
│   │   └── sharpAdapter.ts   # SHARP context builder
│   ├── test-tools.js         # Tool integration tests
│   ├── test-llm.js           # Groq API connectivity test
│   └── package.json
├── dashboard/
│   └── index.html            # Clinical demo dashboard
├── fhir-data/
│   └── sample-patients.json
└── agent-config.json         # Prompt Opinion A2A manifest
```
---

## 🧪 Verified Test Output

Server confirmed running with:
- All 5 MCP tools registered and callable
- FHIR vitals fetch: 6 parameters for patient 592011
- Full deterioration assessment: risk score 100/100, CRITICAL, NEWS2: 8
- Ward scan: 3 patients assessed, all CRITICAL
- Groq LLM integration: ✅ connected

---

## 📚 Clinical Evidence Base

- **NEWS2**: NHS England, NICE guideline NG51, validated 2017
- **Sepsis-3 criteria**: SCCM/ESICM consensus, JAMA 2016
- **Cardiorenal syndrome**: Ronco et al., JACC 2008
- **FHIR R4**: HL7 International, adopted under ONC 21st Century Cures Act
---

*Built for Agents Assemble — The Healthcare AI Endgame · Prompt Opinion Hackathon 2026*
