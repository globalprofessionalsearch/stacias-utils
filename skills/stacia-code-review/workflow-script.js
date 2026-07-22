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
    { title: 'Synthesis' },
    { title: 'Verification' }
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

// ---- Context catalog: reference material staged on disk by the orchestrator ----
// Large context never travels through args by value. The catalog lists paths;
// subagents read them on demand with their read-only tools.
const contextCatalog = a.context || []

function catalogNote(kinds) {
  const items = kinds
    ? contextCatalog.filter(c => kinds.includes(c.kind))
    : contextCatalog
  if (!items.length) return ''
  return 'Reference material (read the paths relevant to your task on demand; ' +
    'do not assume their contents):\n' +
    items.map(c => `- [${c.kind}] ${c.id} — ${c.title}: ${c.path}`).join('\n') +
    '\n\n'
}

const orientContext = catalogNote()

const [orientationA, orientationB] = await parallel([
  () => agent(
    `${personas.orienteerA}\n\n---\n\nCharge: ${safeCharge}\n\n${orientContext}Change set:\n${bundleContext}\n\nTrace how the change delivers the charge (outside-in).`,
    { agentType: RO, tier: 'medium', schema: schemas.orientation, label: 'orienteer-A' }
  ),
  () => agent(
    `${personas.orienteerB}\n\n---\n\nCharge: ${safeCharge}\n\n${orientContext}Change set:\n${bundleContext}\n\nReconstruct what the change does, then reconcile against the charge (inside-out).`,
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
    
    // Every reviewer gets the full context catalog (paths only) and reads what
    // is relevant. The ADR reviewer additionally gets an explicit ADR framing.
    let reviewerContext = catalogNote()
    if (perspective === 'adr') {
      const adrItems = contextCatalog.filter(c => c.kind === 'adr')
      reviewerContext = adrItems.length
        ? `ADR context: ${adrItems.length} accepted ADR(s) staged below. Read each path to check compliance.\n\n` + catalogNote(['adr'])
        : 'ADR context: No ADRs provided.\n\n'
    }
    
    const prompt = `${personas.commonRules}\n\n---\n\n${personas.reviewers[perspective]}\n\n---\n\n` +
      `Charge: ${safeCharge}\n\n` +
      `Max findings: ${config.reviewer.maxFindings}\n\n` +
      reviewerContext +
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

// ---- Verification: confirm Blocker/Major findings ----
phase('Verification')

// Filter to only Blocker and Major findings
const findingsToVerify = (synthesis.consolidated_findings || []).filter(
  f => f.severity === 'Blocker' || f.severity === 'Major'
)

// Fan out parallel verifiers, one per finding
const verificationResults = await parallel(
  findingsToVerify.map((finding, idx) => () => agent(
    `${personas.verifier}\n\n---\n\n` +
    `Change set:\n${bundleContext}\n\n` +
    `Finding to verify:\n${JSON.stringify(finding, null, 2)}\n\n` +
    `Verify this finding. Read the actual code at the cited location.`,
    { agentType: RO, tier: 'medium', schema: schemas.verifier, label: `verify:${idx}` }
  ))
)

// Apply verification results
const verifiedFindings = []
const dismissedFindings = []

findingsToVerify.forEach((finding, idx) => {
  const result = verificationResults[idx]
  if (!result) {
    // Verifier failed - retain finding with low confidence
    verifiedFindings.push({ ...finding, confidence: 'low', verification: 'unverified' })
  } else if (result.outcome === 'dismiss') {
    dismissedFindings.push({ ...finding, verification: 'dismissed', dismissal_reason: result.explanation })
  } else if (result.outcome === 'correct') {
    // Apply corrections
    const corrected = { ...finding, ...result.corrections, verification: 'corrected' }
    if (result.corrections?.location) corrected.location = result.corrections.location
    verifiedFindings.push(corrected)
  } else {
    // retain
    verifiedFindings.push({ ...finding, verification: 'confirmed' })
  }
})

// Rebuild consolidated findings: verified Blocker/Major + unverified Minor/Nit
const minorAndNits = (synthesis.consolidated_findings || []).filter(
  f => f.severity !== 'Blocker' && f.severity !== 'Major'
)
const finalFindings = [...verifiedFindings, ...minorAndNits]

return {
  run_dir: a.run_dir,
  charge: a.charge,
  orientations: { a: orientationA, b: orientationB },
  seamMap: seamMap,
  reviews: reviewResults,
  synthesis: {
    ...synthesis,
    consolidated_findings: finalFindings,
    dismissed_findings: dismissedFindings,
    verification_stats: {
      verified: findingsToVerify.length,
      confirmed: verifiedFindings.filter(f => f.verification === 'confirmed').length,
      corrected: verifiedFindings.filter(f => f.verification === 'corrected').length,
      dismissed: dismissedFindings.length,
      unverified: verifiedFindings.filter(f => f.verification === 'unverified').length
    }
  }
}
