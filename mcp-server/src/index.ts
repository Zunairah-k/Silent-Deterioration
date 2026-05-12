import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import * as http from "http";

import {
  getPatientSummary,
  getPatientVitals,
  getLabResults,
} from "./fhirClient.js";

import { assessDeteriorationRisk } from "./riskEngine.js";
import { enrichAssessmentWithLLM } from "./llmAnalyzer.js";

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

/* -------------------------------------------------------------------------- */
/*                            CREATE MCP SERVER                               */
/* -------------------------------------------------------------------------- */

function createServer() {
  const server = new McpServer({
    name: "silent-deterioration",
    version: "1.0.0",
    description:
      "Healthcare AI MCP server for detecting silent patient deterioration using FHIR R4, NEWS2 scoring, and AI-powered multi-parameter analysis.",
  });

  /* ------------------------------------------------------------------------ */
  /* TOOL 1: GET PATIENT VITALS                                               */
  /* ------------------------------------------------------------------------ */

  server.tool(
    "get_patient_vitals",
    "Fetch patient vital signs from FHIR R4",
    {
      patientId: z.string(),
    },
    async ({ patientId }) => {
      try {
        const vitals = await getPatientVitals(patientId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  patientId,
                  category: "vital-signs",
                  count: vitals.length,
                  vitals,
                  fetchedAt: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching vitals: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  /* ------------------------------------------------------------------------ */
  /* TOOL 2: GET LAB RESULTS                                                  */
  /* ------------------------------------------------------------------------ */

  server.tool(
    "get_lab_results",
    "Fetch patient lab results from FHIR R4",
    {
      patientId: z.string(),
    },
    async ({ patientId }) => {
      try {
        const labs = await getLabResults(patientId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  patientId,
                  category: "laboratory",
                  count: labs.length,
                  labs,
                  fetchedAt: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching labs: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  /* ------------------------------------------------------------------------ */
  /* TOOL 3: DETERIORATION ASSESSMENT                                         */
  /* ------------------------------------------------------------------------ */

  server.tool(
    "assess_deterioration_risk",
    "AI-powered patient deterioration assessment",
    {
      patientId: z.string(),
      includeRecommendations: z.boolean().optional().default(true),
    },
    async ({ patientId, includeRecommendations }) => {
      try {
        const [patient, vitals, labs] = await Promise.all([
          getPatientSummary(patientId),
          getPatientVitals(patientId),
          getLabResults(patientId),
        ]);

        const assessment = assessDeteriorationRisk(
          patient,
          vitals,
          labs
        );

        const enriched = await enrichAssessmentWithLLM(
          assessment,
          GROQ_API_KEY
        );

        const output: any = {
          success: true,
          patientName: assessment.patientName,
          riskScore: assessment.riskScore,
          riskLevel: assessment.riskLevel,

          llmNarrative: enriched.llmNarrative,
          urgencyJustification: enriched.urgencyJustification,
          differentialDiagnoses:
            enriched.differentialDiagnoses,

          clinicalSignals: assessment.clinicalSignals,
          sharpContext: assessment.sharpContext,

          fhirResourceRefs:
            assessment.fhirResourceRefs,

          assessedAt: assessment.assessedAt,
          llmModel: enriched.llmModel,
        };

        if (includeRecommendations) {
          output.recommendedActions =
            enriched.nextSteps ??
            assessment.recommendedActions;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error in assessment: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  /* ------------------------------------------------------------------------ */
  /* TOOL 4: WARD SCAN                                                        */
  /* ------------------------------------------------------------------------ */

  server.tool(
    "scan_ward_for_deterioration",
    "Scan multiple patients and rank by deterioration risk",
    {
      patientIds: z.array(z.string()),
    },
    async ({ patientIds }) => {
      try {
        const ids = patientIds.slice(0, 10);

        const results = await Promise.all(
          ids.map(async (patientId) => {
            try {
              const [patient, vitals, labs] =
                await Promise.all([
                  getPatientSummary(patientId),
                  getPatientVitals(patientId),
                  getLabResults(patientId),
                ]);

              const assessment =
                assessDeteriorationRisk(
                  patient,
                  vitals,
                  labs
                );

              return {
                patientId,
                patientName:
                  assessment.patientName,
                riskScore: assessment.riskScore,
                riskLevel: assessment.riskLevel,
                topConcern:
                  assessment.clinicalSignals.find(
                    (s) => s.status === "critical"
                  )?.reasoning ?? "No major concerns",
              };
            } catch {
              return {
                patientId,
                riskLevel: "UNKNOWN",
                riskScore: 0,
              };
            }
          })
        );

        results.sort(
          (a, b) => b.riskScore - a.riskScore
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  scannedAt:
                    new Date().toISOString(),
                  priorityRanking: results,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Ward scan error: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

/* -------------------------------------------------------------------------- */
/*                                MAIN SERVER                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);

  const useHttp = args.includes("--http");

  const portArg = args.find((a) =>
    a.startsWith("--port=")
  );

  const port = portArg
    ? parseInt(portArg.split("=")[1])
    : 3001;

  if (useHttp) {
    const { SSEServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/sse.js"
    );

    const transports: Record<string, any> = {};

    const httpServer = http.createServer(
      async (req, res) => {
        res.setHeader(
          "Access-Control-Allow-Origin",
          "*"
        );

        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, OPTIONS"
        );

        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type"
        );

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        /* -------------------------- HEALTH CHECK -------------------------- */

        if (req.url === "/health") {
          res.writeHead(200, {
            "Content-Type": "application/json",
          });

          res.end(
            JSON.stringify({
              status: "ok",
              server: "silent-deterioration-mcp",
              version: "1.0.0",
            })
          );

          return;
        }

        /* ----------------------------- SSE ----------------------------- */

        if (
          req.url === "/sse" &&
          req.method === "GET"
        ) {
          try {
            const transport =
              new SSEServerTransport(
                "/messages",
                res
              );

            const server = createServer();

            transports[transport.sessionId] = {
              transport,
              server,
            };

            transport.onclose = async () => {
              delete transports[
                transport.sessionId
              ];
            };

            await server.connect(transport);

            return;
          } catch (err: any) {
            console.error(err);

            res.writeHead(500);

            res.end(
              `SSE connection failed: ${err.message}`
            );

            return;
          }
        }

        /* --------------------------- MESSAGES --------------------------- */

        if (
          req.url?.startsWith("/messages") &&
          req.method === "POST"
        ) {
          const url = new URL(
            req.url,
            `http://localhost:${port}`
          );

          const sessionId =
            url.searchParams.get("sessionId");

          const session = sessionId
            ? transports[sessionId]
            : null;

          if (!session) {
            res.writeHead(404);

            res.end("Session not found");

            return;
          }

          await session.transport.handlePostMessage(
            req,
            res
          );

          return;
        }

        /* ----------------------------- 404 ----------------------------- */

        res.writeHead(404);

        res.end("Not found");
      }
    );

    httpServer.listen(port, () => {
      console.log("");
      console.log(
        "🏥 Silent Deterioration MCP Server running"
      );
      console.log(
        `📡 SSE endpoint: http://localhost:${port}/sse`
      );
      console.log(
        `❤️ Health check: http://localhost:${port}/health`
      );
      console.log(
        "🧠 AI deterioration detection ready"
      );
      console.log(
        "✅ SHARP propagation enabled"
      );
      console.log("");
    });
  } else {
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );

    const server = createServer();

    const transport =
      new StdioServerTransport();

    await server.connect(transport);

    console.log(
      "🏥 Silent Deterioration MCP Server running (STDIO)"
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});