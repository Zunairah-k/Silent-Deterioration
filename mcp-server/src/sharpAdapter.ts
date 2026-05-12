/**
 * SHARP (Structured Healthcare Agent Resource Propagation) Adapter
 * Converts our risk assessments into Prompt Opinion's native SHARP context format
 * so our MCP tools work seamlessly in A2A agent chains on their platform.
 *
 * SHARP context flows patient identity + FHIR tokens through multi-agent call chains
 * without each agent needing to re-authenticate or re-fetch patient context.
 */

import { RiskAssessment } from "./riskEngine";
import { LLMEnrichedAssessment } from "./llmAnalyzer";

export interface SHARPEnvelope {
  specVersion: "1.0";
  contextType: string;
  patientRef: FHIRPatientRef;
  sessionContext: SessionContext;
  clinicalPayload: ClinicalPayload;
  agentChain: AgentChainEntry[];
  propagationRules: PropagationRules;
  createdAt: string;
  expiresAt: string;
}

export interface FHIRPatientRef {
  resourceType: "Patient";
  id: string;
  fhirBaseUrl: string;
  accessScope: string[];
}

export interface SessionContext {
  sessionId: string;
  initiatingAgent: string;
  ehrSystem: string;
  clinicianContext?: string;
}

export interface ClinicalPayload {
  alertType: string;
  severity: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  compositeRiskScore: number;
  news2Score: number;
  summary: string;
  criticalFlags: string[];
  crossPatternAlerts: string[];
  differentialDiagnoses?: string[];
  recommendedActions: string[];
  fhirObservationRefs: string[];
  llmReasoning?: string;
}

export interface AgentChainEntry {
  agentId: string;
  agentName: string;
  role: string;
  timestamp: string;
  contribution: string;
}

export interface PropagationRules {
  forwardToAgents: boolean;
  requiresAcknowledgment: boolean;
  escalationThreshold: number;
  ttlMinutes: number;
  auditLog: boolean;
}

export function buildSHARPEnvelope(
  assessment: RiskAssessment,
  enriched?: LLMEnrichedAssessment,
  sessionId?: string
): SHARPEnvelope {
  const criticalFlags = assessment.clinicalSignals
    .filter((s) => s.status === "critical")
    .map((s) => `${s.parameter}: ${s.value}`);

  const crossPatterns: string[] =
    assessment.sharpContext.structuredFindings.crossParameterPatterns ?? [];

  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour TTL

  return {
    specVersion: "1.0",
    contextType: "deterioration-alert",
    patientRef: {
      resourceType: "Patient",
      id: assessment.patientId,
      fhirBaseUrl: "https://hapi.fhir.org/baseR4",
      accessScope: [
        "Observation.read",
        "Patient.read",
        "Condition.read",
        "MedicationRequest.read",
      ],
    },
    sessionContext: {
      sessionId: sessionId ?? `session-${Date.now()}`,
      initiatingAgent: "silent-deterioration-mcp",
      ehrSystem: "HAPI-FHIR-R4",
      clinicianContext: "ward-monitoring",
    },
    clinicalPayload: {
      alertType: "silent-deterioration",
      severity: assessment.riskLevel,
      compositeRiskScore: assessment.riskScore,
      news2Score: assessment.sharpContext.structuredFindings.news2Score ?? 0,
      summary: enriched?.llmNarrative ?? assessment.aiReasoning.split("\n")[0],
      criticalFlags,
      crossPatternAlerts: crossPatterns,
      differentialDiagnoses: enriched?.differentialDiagnoses,
      recommendedActions: enriched?.nextSteps ?? assessment.recommendedActions,
      fhirObservationRefs: assessment.fhirResourceRefs,
      llmReasoning: enriched?.llmNarrative,
    },
    agentChain: [
      {
        agentId: "silent-deterioration-mcp-v1",
        agentName: "Silent Deterioration MCP",
        role: "data-acquisition-and-risk-scoring",
        timestamp: now.toISOString(),
        contribution: `Fetched FHIR vitals + labs, computed NEWS2=${assessment.sharpContext.structuredFindings.news2Score}, detected ${crossPatterns.length} cross-parameter pattern(s), composite risk score: ${assessment.riskScore}/100`,
      },
    ],
    propagationRules: {
      forwardToAgents: true,
      requiresAcknowledgment: assessment.riskLevel === "CRITICAL" || assessment.riskLevel === "HIGH",
      escalationThreshold: 70,
      ttlMinutes: 60,
      auditLog: true,
    },
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

// Extends the SHARP envelope when another agent in the chain processes it
export function extendAgentChain(
  envelope: SHARPEnvelope,
  agentId: string,
  agentName: string,
  role: string,
  contribution: string
): SHARPEnvelope {
  return {
    ...envelope,
    agentChain: [
      ...envelope.agentChain,
      {
        agentId,
        agentName,
        role,
        timestamp: new Date().toISOString(),
        contribution,
      },
    ],
  };
}