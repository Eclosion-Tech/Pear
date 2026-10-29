import type { McpToolEntry } from './types';
type Schema = NonNullable<McpToolEntry['inputSchema']['properties']>[string];
const id: Schema = { type: 'string', minLength: 1, maxLength: 256 };
const text: Schema = { type: 'string', minLength: 1, maxLength: 8192 };
const timestamp: Schema = { type: 'string', format: 'date-time', description: 'Canonical UTC ISO timestamp, for example 2026-10-27T12:00:00.000Z.' };
const array = (items: Schema, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems: 256 });
const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({ type: 'object', properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const source = object({ owner: id, uri: { type: 'string', minLength: 1, maxLength: 4096 }, recordId: id, version: id }, ['version']);
const evidence = object({ id, source, kind: { type: 'string', enum: ['interview', 'usage', 'research', 'technical', 'operational', 'artifact'] }, observedAt: timestamp, capturedAt: timestamp, summary: text });
const assignment = object({ id, objective: text, capability: id, resource: id, acceptanceCriteria: array(text, 1), reservedUnits: { type: 'number', minimum: 0 }, dependencies: array(id),
  decisionRequirements: array(object({ decisionId: id, optionId: id })), ticket: source }, ['ticket']);
const decision = object({ id, category: { type: 'string', enum: ['direction', 'taste', 'architecture'] }, question: text,
  options: array(object({ id, description: text }), 2), recommendedOptionId: id, evidenceIds: array(id, 1) });
const metric = object({ id, version: { type: 'integer', minimum: 1 }, name: text, outcome: text, population: text,
  aggregation: { type: 'string', enum: ['ratio', 'count', 'mean'] }, unit: id, minimumSampleSize: { type: 'integer', minimum: 1 },
  target: object({ operator: { type: 'string', enum: ['gte', 'lte'] }, value: { type: 'number' } }),
  baseline: object({ value: { type: 'number' }, evidenceIds: array(id, 1), windowStart: timestamp, windowEnd: timestamp }) }, ['baseline']);
const observation = object({ id, metricId: id, definitionVersion: { type: 'integer', minimum: 1 }, population: text,
  windowStart: timestamp, windowEnd: timestamp, value: { type: ['number', 'null'] }, sampleSize: { type: 'integer', minimum: 0 },
  numerator: { type: 'integer', minimum: 0 }, denominator: { type: 'integer', minimum: 0 }, evidenceIds: array(id, 1) }, ['numerator', 'denominator']);
const evaluation = object({ id, verdict: { type: 'string', enum: ['outcome_met', 'hypothesis_disproved', 'inconclusive'] }, rationale: text,
  evidenceIds: array(id, 1), observationIds: array(id), hypothesisAssessments: array(object({ hypothesisId: id,
    status: { type: 'string', enum: ['supported', 'contradicted', 'inconclusive'] }, evidenceIds: array(id, 1) }), 1) });

export const productOperationsPayloadSchema: Schema = { type: 'object', oneOf: [
  object({ type: { const: 'record_evidence' }, evidence }),
  object({ type: { const: 'request_decision' }, decision }),
  object({ type: { const: 'propose_assignment' }, assignment }),
  object({ type: { const: 'revise_assignment' }, assignment }),
  object({ type: { const: 'define_metric' }, metric }),
  object({ type: { const: 'begin_observation' }, evidenceIds: array(id, 1) }),
  object({ type: { const: 'record_observation' }, observation }),
  object({ type: { const: 'evaluate' }, evaluation }),
] };
