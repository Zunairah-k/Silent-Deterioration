import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import { getPatientSummary, getPatientVitals, getLabResults } from "./fhirClient.js";
import { assessDeteriorationRisk } from "./riskEngine.js";
import { enrichAssessmentWithLLM } from "./llmAnalyzer.js";
import { buildSHARPEnvelope } from "./sharpAdapter.js";

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

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
      const enriched = await enrichAssessmentWithLLM(assessment, GROQ_API_KEY);

const output: any = {
  success: true,
  sharpContext: assessment.sharpContext,
  riskScore: assessment.riskScore,
  riskLevel: assessment.riskLevel,
  patientName: assessment.patientName,
  llmNarrative: enriched.llmNarrative,           // ADD
  differentialDiagnoses: enriched.differentialDiagnoses, // ADD
  urgencyJustification: enriched.urgencyJustification,   // ADD
  clinicalSignals: assessment.clinicalSignals,
  fhirResourceRefs: assessment.fhirResourceRefs,
  assessedAt: assessment.assessedAt,
  llmModel: enriched.llmModel,                   // ADD
};
if (includeRecommendations) {
  output.recommendedActions = enriched.nextSteps ?? assessment.recommendedActions; // prefer LLM actions
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
import * as http from "http";
import * as readline from "readline";

async function main() {
  const args = process.argv.slice(2);
  const useHttp = args.includes("--http");
  const portArg = args.find(a => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1]) : 3001;

  if (useHttp) {
    // HTTP/SSE transport for Prompt Opinion platform
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    
    const transports: Record<string, any> = {};

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        transports[transport.sessionId] = transport;
        await server.connect(transport);
        transport.onclose = () => delete transports[transport.sessionId];
        return;
      }

      if (req.url?.startsWith("/messages") && req.method === "POST") {
        const sessionId = new URL(req.url, `http://localhost`).searchParams.get("sessionId");
        const transport = sessionId ? transports[sessionId] : null;
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(404);
          res.end("Session not found");
        }
        return;
      }

      // Health check
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "silent-deterioration-mcp", version: "1.0.0" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(port, () => {
      console.error(`🏥 Silent Deterioration MCP Server running (HTTP mode)`);
      console.error(`📡 SSE endpoint: http://localhost:${port}/sse`);
      console.error(`🧠 NEWS2 + AI cross-parameter detection ready`);
      console.error(`✅ SHARP context propagation enabled`);
    });

  } else {
    // Default: stdio transport (for local testing)
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🏥 Silent Deterioration MCP Server running");
    console.error("📡 Connected to FHIR R4 endpoint");
    console.error("🧠 NEWS2 + AI cross-parameter detection ready");
    console.error("✅ SHARP context propagation enabled");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});