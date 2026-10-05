// @vitest-environment node
/*
 * Enforcement: the finance cross-charge surfaces are BILL-ANCHORED (mig 0059).
 * Money = the provider bill homed to the cost-owning unit
 * (v_finance_bill_chargeback); the per-project split = v_finance_project_overlay
 * (the bill split by tagged share + the untagged share, mig 0146). Neither may
 * SUM attribution_record directly for a charge — that is the OTel estimate, not
 * the bill.
 *
 * The retired /rollups/finance* surfaces used to be grepped here directly; they
 * were removed in the reporting-consolidation cutover (chore/retire-rollups-finance).
 * The surviving finance money surface is /reports/finance, which reads the
 * bill-anchored views via server/reporting/finance.ts (its own view-firewall
 * coverage lives in tests/integration/reports/finance*.test.ts).
 *
 * What THIS gate still pins is the deliberate allowlist on the SIGNAL surfaces:
 * manager + practice-velocity are intentionally NOT gated — they show all team
 * activity and read attribution_record by design.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('finance bill-anchored gate — signal-surface allowlist', () => {
  it('signal surfaces (manager, velocity) are intentionally NOT gated', () => {
    // Documented allowlist: these show all activity, so they read attribution_record.
    expect(read('server/api/v1/rollups/manager.get.ts')).toContain('attribution_record')
    expect(read('server/api/v1/rollups/practice/[ouId]/velocity.get.ts')).toContain('attribution_record')
  })
})
