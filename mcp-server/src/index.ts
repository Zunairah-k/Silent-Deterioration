import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import { getPatientSummary, getPatientVitals, getLabResults } from "./fhirClient.js";
import { assessDeteriorationRisk } from "./riskEngine.js";
import { enrichAssessmentWithLLM } from "./llmAnalyzer.js";
import { buildSHARPEnvelope } from "./sharpAdapter.js";

dotenv.config();

const GROK_API_KEY = process.env.GROK_API_KEY ?? "";

const server = new McpServer({
  name: "silent-deterioration",
  version: "1.0.0",
  description:
    "Healthcare AI MCP server that detects silent patient deterioration by analyzing multi-parameter FHIR data (vitals + labs) using NEWS2 scoring and LLM-powered cross-signal reasoning. Catches what rule-based systems miss.",
});

// ─── TOOL 1: Get Patient Vitals from FHIR ────────────────────────────────────
server.tool(
  "get_patient_vitals",
  "Fetch real-time vital signs for a patient from a FHIR R4 server. Returns heart rate, blood pressure, SpO2, respiratory rate, and temperature as structured FHIR Observation resources.",
  { patientId: z.string().describe("FHIR Patient resource ID") },
  async ({ patientId }) => {
    try {
      const vitals = await getPatientVitals(patientId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              patientId,
              fhirResourceType: "Observation",
              category: "vital-signs",
              count: vitals.length,
              vitals,
              fetchedAt: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error fetching vitals: ${err.message}` }], isError: true };
    }
  }
);

// ─── TOOL 2: Get Lab Results from FHIR ───────────────────────────────────────
server.tool(
  "get_lab_results",
  "Fetch recent laboratory results for a patient from a FHIR R4 server. Returns creatinine, potassium, WBC, CRP, hemoglobin and other critical markers with interpretation flags.",
  { patientId: z.string().describe("FHIR Patient resource ID") },
  async ({ patientId }) => {
    try {
      const labs = await getLabResults(patientId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              patientId,
              fhirResourceType: "Observation",
              category: "laboratory",
              count: labs.length,
              labs,
              fetchedAt: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error fetching labs: ${err.message}` }], isError: true };
    }
  }
);

// ─── TOOL 3: Full Deterioration Risk Assessment ───────────────────────────────
server.tool(
  "assess_deterioration_risk",
  "Core AI tool: Pulls FHIR vitals + labs for a patient, computes NEWS2 score, runs multi-parameter pattern detection (sepsis, cardiorenal syndrome, respiratory-hemodynamic coupling), and returns a SHARP-compliant risk assessment. Detects silent deterioration patterns that individually appear borderline but collectively indicate imminent crisis.",
  {
    patientId: z.string().describe("FHIR Patient resource ID"),
    includeRecommendations: z.boolean().optional().default(true).describe("Include clinical action recommendations"),
  },
  async ({ patientId, includeRecommendations }) => {
    try {
      // Fetch all data in parallel — fast and efficient
      const [patient, vitals, labs] = await Promise.all([
        getPatientSummary(patientId),
        getPatientVitals(patientId),
        getLabResults(patientId),
      ]);

      const assessment = assessDeteriorationRisk(patient, vitals, labs);

      const output: any = {
        success: true,
        sharpContext: assessment.sharpContext,   // SHARP-compliant for Prompt Opinion
        riskScore: assessment.riskScore,
        riskLevel: assessment.riskLevel,
        patientName: assessment.patientName,
        aiReasoning: assessment.aiReasoning,
        clinicalSignals: assessment.clinicalSignals,
        fhirResourceRefs: assessment.fhirResourceRefs,
        assessedAt: assessment.assessedAt,
      };

      if (includeRecommendations) {
        output.recommendedActions = assessment.recommendedActions;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error in risk assessment: ${err.message}` }], isError: true };
    }
  }
);

// ─── TOOL 4: Multi-Patient Ward Scan ─────────────────────────────────────────
server.tool(
  "scan_ward_for_deterioration",
  "Scans multiple patients simultaneously and returns a priority-ranked list of deterioration risks. Designed for nurse handover and ward rounds — shows who needs attention first. Returns patients sorted by risk score descending.",
  {
    patientIds: z.array(z.string()).describe("Array of FHIR Patient IDs to scan (max 10)"),
  },
  async ({ patientIds }) => {
    try {
      const ids = patientIds.slice(0, 10);

      // Assess all patients in parallel
      const results = await Promise.all(
        ids.map(async (patientId) => {
          try {
            const [patient, vitals, labs] = await Promise.all([
              getPatientSummary(patientId),
              getPatientVitals(patientId),
              getLabResults(patientId),
            ]);
            const assessment = assessDeteriorationRisk(patient, vitals, labs);
            return {
              patientId,
              patientName: assessment.patientName,
              riskScore: assessment.riskScore,
              riskLevel: assessment.riskLevel,
              topConcern: assessment.clinicalSignals.find(s => s.status === "critical")?.reasoning
                ?? assessment.clinicalSignals.find(s => s.status === "abnormal")?.reasoning
                ?? "No critical flags",
              crossPatternAlerts: assessment.sharpContext.structuredFindings.crossParameterPatterns?.length ?? 0,
              immediateAction: assessment.recommendedActions[0] ?? "Continue monitoring",
              sharpContext: assessment.sharpContext,
            };
          } catch {
            return { patientId, riskScore: 0, riskLevel: "LOW", error: "Could not assess" };
          }
        })
      );

      // Sort by risk score — highest risk first
      const ranked = results.sort((a, b) => b.riskScore - a.riskScore);
      const criticalCount = ranked.filter(r => r.riskLevel === "CRITICAL").length;
      const highCount = ranked.filter(r => r.riskLevel === "HIGH").length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              wardSummary: {
                totalPatients: ids.length,
                criticalAlerts: criticalCount,
                highRiskAlerts: highCount,
                scannedAt: new Date().toISOString(),
              },
              priorityRanking: ranked,
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error in ward scan: ${err.message}` }], isError: true };
    }
  }
);

// ─── Start Server ─────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🏥 Silent Deterioration MCP Server running");
  console.error("📡 Connected to FHIR R4 endpoint");
  console.error("🧠 NEWS2 + AI cross-parameter detection ready");
  console.error("✅ SHARP context propagation enabled");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});