/**
 * stacia-code-review workflow script
 * 
 * Static, versioned workflow logic. The orchestrator reads this file and
 * passes it to the workflow tool along with args containing:
 * - run_dir, charge, repos (from manifest)
 * - personas (pre-read by orchestrator)
 * - schemas (pre-read by orchestrator)
 * 
 * This script runs in a sandboxed vm with no fs/require/bash. All external
 * data comes through args.
 */

export const meta = {
  name: 'stacia_code_review',
  description: 'Bounded-context code review: orient, reconcile, review, synthesize',
  phases: [
    { title: 'Comprehension' },
    { title: 'Review' },
    { title: 'Synthesis' }
  ],
}

// Parse args if passed as string
const a = typeof args === 'string' ? JSON.parse(args) : args

// Sanitize charge for prompt injection safety
// Escape: newlines, markdown separators, code fences, backticks
const safeCharge = a.charge
  .replace(/\n/g, ' ')
  .replace(/\r/g, '')
  .replace(/---/g, '—')
  .replace(/```/g, "'''")
  .replace(/`/g, "'")

const RO = 'stacia-review-readonly'

// Extract from args (orchestrator pre-reads these)
const { personas, schemas, config } = a

// Workflow config (scoped)
const K = config.workflow.maxRounds
const ROUND_TIMEOUT = config.workflow.roundTimeoutMs
const PERSPECTIVES = config.reviewer.perspectives

// ---- Comprehension: two orienteers in parallel, then reconcile ----
phase('Comprehension')

const bundleContext = a.repos.map(r => 
  `Repo: ${r.repo}, bundle: ${r.bundle}, local path: ${r.path}`
).join('\n')

const [orientationA, orientationB] = await parallel([
  () => agent(
    `${personas.orienteerA}\n\n---\n\nCharge: ${safeCharge}\n\nChange set:\n${bundleContext}\n\nTrace how the change delivers the charge (outside-in).`,
    { agentType: RO, tier: 'medium', schema: schemas.orientation, label: 'orienteer-A' }
  ),
  () => agent(
    `${personas.orienteerB}\n\n---\n\nCharge: ${safeCharge}\n\nChange set:\n${bundleContext}\n\nReconstruct what the change does, then reconcile against the charge (inside-out).`,
    { agentType: RO, tier: 'medium', schema: schemas.orientation, label: 'orienteer-B' }
  )
])

const seamMap = await agent(
  `${personas.reconciler}\n\n---\n\nCharge: ${safeCharge}\n\nSeam bounds: ${config.reconciler.minSeams}-${config.reconciler.maxSeams} seams.\n\nOrienteer A (claim→code) output:\n${JSON.stringify(orientationA)}\n\nOrienteer B (code→claim) output:\n${JSON.stringify(orientationB)}\n\nMerge these into a unified orientation and seam map.`,
  { agentType: RO, tier: 'medium', schema: schemas.seamMap, label: 'reconciler' }
)

// ---- Review: K-round loop per perspective, parallel across perspectives ----
phase('Review')

async function runReviewer(perspective) {
  let findingsSoFar = []
  let result = null
  
  for (let round = 1; round <= K; round++) {
    const isLastRound = round === K
    const prompt = `${personas.commonRules}\n\n---\n\n${personas.reviewers[perspective]}\n\n---\n\n` +
      `Charge: ${safeCharge}\n\n` +
      `Max findings: ${config.reviewer.maxFindings}\n\n` +
      `Orientation:\n${seamMap.merged_orientation}\n\n` +
      `Seam map:\n${JSON.stringify(seamMap.seams)}\n\n` +
      `Round ${round} of ${K}${isLastRound ? ' (FINAL - must produce write-up)' : ''}\n\n` +
      `Change set:\n${bundleContext}\n\n` +
      (findingsSoFar.length > 0 ? `Findings so far:\n${JSON.stringify(findingsSoFar)}\n\n` : '') +
      `Review the change from the ${perspective} perspective. Focus on high-priority seams.`
    
    result = await agent(prompt, {
      agentType: RO,
      tier: 'medium',
      schema: schemas.reviewer,
      label: `${perspective}:${round}`,
      agentTimeoutMs: ROUND_TIMEOUT
    })
    
    if (!result) {
      // Agent failed/timed out - keep existing findings, mark spillover
      // Don't degrade confidence of findings from successful previous rounds
      return {
        perspective,
        findings: findingsSoFar,
        spillover: true,
        moreExploration: false,
        note: `Review incomplete - agent failed on round ${round}`
      }
    }
    
    findingsSoFar = result.findings || []
    
    if (!result.moreExploration || isLastRound) {
      return result
    }
  }
  
  return result
}

const reviewResults = await parallel(
  PERSPECTIVES.map(p => () => runReviewer(p))
)

// ---- Synthesis: consolidate, verdict, seam accounting ----
phase('Synthesis')

const synthesis = await agent(
  `${personas.synthesizer}\n\n---\n\n` +
  `Charge: ${safeCharge}\n\n` +
  `Follow-up threshold: ≥${config.synthesis.followUpThreshold} Major/Blocker findings triggers recommendation.\n\n` +
  `Orientation:\n${seamMap.merged_orientation}\n\n` +
  `Seam map:\n${JSON.stringify(seamMap.seams)}\n\n` +
  `Reviewer outputs:\n${JSON.stringify(reviewResults)}\n\n` +
  `Synthesize: consolidate findings (preserve priorities), produce charge verdict, ` +
  `account for every seam (cleared/finding/under-explored), recommend follow-up if triggered.`,
  { agentType: RO, tier: 'big', schema: schemas.synthesis, label: 'synthesizer' }
)

return {
  run_dir: a.run_dir,
  charge: a.charge,
  orientations: { a: orientationA, b: orientationB },
  seamMap: seamMap,
  reviews: reviewResults,
  synthesis: synthesis
}
