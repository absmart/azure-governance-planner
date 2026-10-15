# Changelog

Changes to the Azure Governance Planner, newest first. Each change is deployed to the hosted app when it reaches `main`.

## 2026-10-14

### Added

- **Any built-in initiative as a custom assignment.** The assignment picker searches all 188 built-in initiatives, not only the frameworks and ALZ's. An initiative's policies count toward coverage with their default effects, and their remediation roles are exported.
- **Compliance in the Excel report.** With an Azure import that has compliance state, the compliance report adds a "Compliance in Azure" sheet: every in-scope control's state in the tenant, non-compliant resources and failing policies, plus a summary per framework. The top bar uses the latest such import; Compare has a button for the one shown.
- **Terragrunt adopts existing resources.** A migration export in Terragrunt format includes `imports.tf` beside the environment's `terragrunt.hcl`, as the Terraform export does.
- **Custom assignments.** **+ Add an assignment** on any management group assigns any built-in policy, with its effect, enforcement and parameters. Custom assignments can be overridden, exempted and exported like any other.
- **Compliance state from Azure.** An optional third Resource Graph query imports how many resources comply with each policy. Compare rates each framework control compliant, non-compliant or not evaluated, and lists the failing policies.
- **Migration plan.** With an Azure import on one side of Compare and a design on the other, the plan lists the steps between them in five phases:
  1. Create the missing management groups.
  2. Add assignments, the blocking ones in DoNotEnforce first.
  3. Review compliance.
  4. Enforce, fewest affected resources first.
  5. Remove leftover assignments, as `az` commands.

  Phases 1–2 and 4 export with a `MIGRATION.md`. The Terraform export adds `imports.tf`, so existing management groups, assignments and custom definitions are adopted rather than recreated.
- **Cost view.** A rough monthly cost of the Defender plans, Log Analytics ingestion, Backup and DDoS Network Protection, from counts of the estate you enter. It uses approximate list prices, and the top bar shows the total.
- **Change tracking for saved designs.** Each saved design records what it deployed. When a catalog update or an app change alters that, the Designs list flags the design. Opening it lists what changed, until you mark it as reviewed.
- **Defender for Cloud plans.** A checklist under the Defender guardrail chooses which plans are turned on. All are on by default except Defender CSPM and AI services. ALZ's own assignment leaves most plans Disabled, so exports previously turned none on.
- **Design links.** **Share** makes a link that carries the design itself after the `#`, so nothing is uploaded. The export's environment values are left out unless you include them.

### Changed

- UI tests run in a simulated browser (jsdom) with the rest of the tests, so the deploy checks the app's screens too.

## 2026-10-13

### Added

- **Import from Azure and compare.** Compare puts the current design, a saved design or an imported tenant side by side, covering:
  - a Venn diagram of the policies on each side
  - framework coverage for each side
  - which assignments and management groups differ

  Import with a read-only Resource Graph command, or with Resource Graph Explorer CSV downloads from the portal.
- **Compliance report.** An Excel workbook for auditors with a summary, every in-scope control, the assignments, exemptions and overrides, and the privileged access settings.
- **ALZ custom roles.** ALZ's custom roles are defined at the top management group and can be managed by PIM.
- **Exemption expiry warnings.** The app flags exemptions that expire within 30 days, and leaves expired ones out of the export.
- **Inherited assignments filter.** A management group's assignments can be listed as assigned here, inherited from a parent, or both.
- **Exclude manual-only controls.** Turns off the frameworks' manual-attestation policies in the export.

### Changed

- **Coverage reflects the whole design.** Control coverage now accounts for exemptions, excluded scopes, manual controls and PIM, and marks controls that only partly apply.
- **Locked parking lot.** Nothing can be deployed in a parking-lot subscription until it's moved to its landing zone.
- **Private DNS zones link to hub networks.** The zones are linked to the hub virtual networks you list.
- The deploy workflow runs on a pinned runner image (ubuntu-24.04).

## 2026-10-12

### Added

- **First version.** Pick compliance frameworks and governance decisions to get an Azure Landing Zones management group hierarchy, policy assignments and per-framework control coverage.
- **Infrastructure as code export.** Bicep, Terraform or Terragrunt, with generic templates, the design as data and a small values file per environment.
- **Platform resources in the export.** The export creates what ALZ's policies point at:
  - a Log Analytics workspace
  - data collection rules
  - the Azure Monitor Agent identity
  - common private DNS zones
- **Naming convention.** Exported resources are named `<app>-<environment>-<region>-<int>-<type>`.
- **Single platform subscription option.** One subscription in one Platform management group can hold the whole platform.
- **Optional Local landing zone.** A Local landing zone for Azure Local is available, off by default.
- **Azure Government support.** Includes Government regions, private DNS zone names and policy availability.
- **Per-assignment overrides and exemptions.** Overrides cover enforcement mode, removal, excluded scopes and parameters. Exemptions can be set at a management group, subscription or resource group.
- **Saved designs.** Save, open, duplicate, rename, delete, and back up to a file.
- **Parking lot.** A Parking lot management group is the default home for new subscriptions, on by default.
- **Privileged Identity Management.** Eligible groups, role settings by compliance profile, and the controls PIM addresses.
- **Weekly catalog refresh.** A pull request updates the policy catalog and ALZ library release each Monday.
- **Hosting.** The app is hosted on Azure Static Web Apps and deployed on every push to `main`.

### Changed

- DDoS Network Protection is opt-in, because a plan costs about US$2,944 a month.
