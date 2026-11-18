import { WorkspaceSecretsSection } from './secrets-section'
import { TransferSection } from './transfer-section'

/**
 * Settings → Data & privacy (design doc, Proposal 8): workspace Secrets and Transfer as one page —
 * what this machine keeps and moves. Each card keeps the id of the page it replaced, so
 * `/settings/global/transfer` lands on `#transfer`.
 */
export function DataPrivacySection() {
  return (
    <div data-slot="data-privacy-section" className="flex w-full flex-col gap-5">
      {/* Anchors on the wrappers, not the cards: an old link must land while the data loads. */}
      <div id="workspace-secrets" className="scroll-mt-16"><WorkspaceSecretsSection /></div>
      <div id="transfer" className="scroll-mt-16"><TransferSection /></div>
    </div>
  )
}
