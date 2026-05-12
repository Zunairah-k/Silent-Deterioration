import axios from "axios";
import { RiskAssessment } from "./riskEngine";

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const GROK_MODEL = "grok-3-mini";

export interface LLMEnrichedAssessment {
  originalAssessment: RiskAssessment;
  llmNarrative: string;
  differentialDiagnoses: string[];
  urgencyJustification: string;
  nextSteps: string[];
  llmModel: string;
  enrichedAt: string;
}

export async function enrichAssessmentWithLLM(
  assessment: RiskAssessment,
  apiKey: string
): Promise<LLMEnrichedAssessment> {
  const prompt = buildClinicalPrompt(assessment);

  try {
    const response = await axios.post(
      GROK_API_URL,
      {
        model: GROK_MODEL,
        messages: [
          {
            role: "system",
            content: `You are a senior ICU physician AI assistant. You receive structured patient data 
including vital signs, lab results, NEWS2 scores, and cross-parameter pattern alerts. 
Your job is to provide concise, clinically actionable reasoning that a busy attending physician 
can act on immediately. Be direct, specific, and prioritize life-threatening conditions first.
Always respond in valid JSON only — no markdown, no preamble.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2, // Low temp for clinical consistency
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const raw = response.data.choices[0].message.content;
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return {
      originalAssessment: assessment,
      llmNarrative: parsed.narrative ?? "Unable to generate narrative",
      differentialDiagnoses: parsed.differentialDiagnoses ?? [],
      urgencyJustification: parsed.urgencyJustification ?? "",
      nextSteps: parsed.nextSteps ?? [],
      llmModel: GROK_MODEL,
      enrichedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    // Graceful fallback — MCP still works even if LLM call fails
    return {
      originalAssessment: assessment,
      llmNarrative: assessment.aiReasoning,
      differentialDiagnoses: ["Unable to generate differential — LLM unavailable"],
      urgencyJustification: `Risk score ${assessment.riskScore}/100 (${assessment.riskLevel})`,
      nextSteps: assessment.recommendedActions,
      llmModel: "fallback",
      enrichedAt: new Date().toISOString(),
    };
  }
}

function buildClinicalPrompt(assessment: RiskAssessment): string {
  const signals = assessment.clinicalSignals
    .filter((s) => s.status !== "normal")
    .map((s) => `- ${s.parameter}: ${s.value} [${s.status.toUpperCase()}] — ${s.reasoning}`)
    .join("\n");

  const patterns =
    assessment.sharpContext.structuredFindings.crossParameterPatterns?.join("\n") ??
    "None detected";

  return `
Patient: ${assessment.patientName}
Risk Score: ${assessment.riskScore}/100 (${assessment.riskLevel})
NEWS2 Score: ${assessment.sharpContext.structuredFindings.news2Score}

ABNORMAL CLINICAL SIGNALS:
${signals || "None"}

AI-DETECTED CROSS-PARAMETER PATTERNS:
${patterns}

Based on the above, respond ONLY with a JSON object in this exact format:
{
  "narrative": "2-3 sentence clinical summary of what is happening to this patient",
  "differentialDiagnoses": ["Most likely diagnosis", "Second possibility", "Third possibility"],
  "urgencyJustification": "One sentence explaining why this risk level is correct",
  "nextSteps": ["Most urgent action", "Second action", "Third action", "Fourth action"]
}
`;
}