# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Azure Governance Planner: a static, client-only React 18 + TypeScript + Vite app. You pick compliance frameworks (NIST 800-53, FedRAMP, CMMC, CIS, PCI DSS, ISO 27001 and others) and governance decisions, and it suggests an Azure management group hierarchy, Azure Policy assignments, control coverage and Privileged Identity Management settings. It exports all of that as Bicep, Terraform or Terragrunt. There is no backend: state lives in browser `localStorage`. `README.md` is the user-facing feature description; keep it in sync when behaviour changes. It is a sibling of ALZ CIDR Planner (`c:\repos\cloud-network-calc`), and shares its stack, look, naming scheme, designs dialog and Terragrunt layout.

## Commands

```powershell
npm install
npm run dev                        # Vite dev server, http://localhost:5173
npm test                           # vitest run: src/lib/*.test.ts and the jsdom UI tests
npx vitest run src/lib/iac.test.ts # one file
npx vitest run -t "Azure Government"  # tests whose name matches
npm run build                      # tsc (strict, noUnusedLocals/Parameters) then vite build → dist/
npm run update-catalog             # refresh src/data/catalog.json and public/alz-library.json (no Azure login needed)
node scripts/catalog-diff.mjs <old> <new>  # summarize the changes between two catalog snapshots
```

There is no linter or formatter; `tsc` in `npm run build` is the only static check.

To write sample exports in every format for checking with real tools, run the tests with `IAC_OUT_DIR` set (PowerShell: `$env:IAC_OUT_DIR='out'; npx vitest run src/lib/iac.test.ts`). The sample is the "everything" design in `iac.test.ts`: every framework, strict, confidential, Local, a locked parking lot, overrides, exemptions at all three scope kinds, and manual-only controls excluded. Validate it before committing IaC changes:

```bash
az bicep build --file out/bicep/main.bicep --stdout > /dev/null
az bicep build-params --file out/bicep/prod.bicepparam --stdout > /dev/null
cd out/terraform && terraform init -backend=false && terraform validate && terraform fmt -check .
# read-only, with a logged-in az CLI (fill management_subscription_id / private_dns_zone_subscription_id in prod.tfvars first):
ARM_SUBSCRIPTION_ID=<sub> terraform plan -var-file=prod.tfvars
cd ../terragrunt && terragrunt hcl fmt --check
```

`terraform fmt` is strict about alignment. In generated HCL, runs of single-line attributes are aligned, and a multi-line value (or a comment line) ends the run. `hclJson()` in `iac.ts` follows that rule.

## Deploy

The app is hosted on Azure Static Web Apps (`swa-azure-governance-planner` in resource group `rg-azure-governance-planner`, subscription "ABS Visual Studio Enterprise", https://lemon-coast-0a2a7820f.2.azurestaticapps.net). Every push to `main` deploys: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) tests, builds and uploads `dist/` with the repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. When setting that secret from Windows PowerShell 5.1, pass the token with `gh secret set --body`; piping it adds a newline and the deploy fails with "deployment_token provided was invalid". The GitHub repo is `absmart/azure-governance-planner` (public). `gh` is at `C:\Program Files\GitHub CLI\gh.exe` and isn't on PATH.

[.github/workflows/update-catalog.yml](.github/workflows/update-catalog.yml) runs every Monday (and by hand). It moves `ALZ_REF` to the latest `platform/alz/*` release, runs `update-catalog`, tests and builds, and opens or updates a PR on `automated/update-catalog` with a `catalog-diff.mjs` summary when anything changed. The script keeps the previous `generated` date when nothing else changed, so quiet weeks open no PR. The repo setting "Allow GitHub Actions to create and approve pull requests" is on for this.

## Architecture

All logic is pure functions in `src/lib/`, where the logic tests live; `src/components/` is UI over it. [src/App.ui.test.tsx](src/App.ui.test.tsx) drives the whole app in jsdom (views, decisions, overrides and exemptions, designs, PIM, share links, export, report, compare) with the helpers in [src/test/dom.tsx](src/test/dom.tsx); [src/test/azureFixture.ts](src/test/azureFixture.ts) is the synthetic Resource Graph export both the compare and UI tests use. `App.tsx` holds the `DesignInput` and the export settings in `useState`; there is no state library.

**Catalog** (`src/data/catalog.json`, types in `catalog.ts`): a committed snapshot built by `scripts/update-catalog.mjs` from AzAdvertizer's CSV exports (policy names, effects, roles, cloud availability, initiative members with reference IDs), the Azure/azure-policy regulatory initiatives (control mappings, effect parameters), the Azure Landing Zones library pinned to `ALZ_REF` (architecture, archetypes, assignments) and NIST OSCAL (800-53 titles and SP 800-53B baselines). Keys are short because it ships to the browser: `n` name, `e` effect, `a` allowed effects, `r` role GUIDs, `ng` not in Azure Government, `dp`/`pv` deprecated/preview. `Member.r` lists the initiative reference IDs a policy is included under (needed for exemptions and overrides). The ALZ custom definitions and assignment parameters, which only the export needs, go to `public/alz-library.json`, fetched by the export dialog on demand. Every built-in policy (about 3,700 with the manual "Static" ones; the catalog has the 1,600 the frameworks and ALZ use) goes to `public/policy-index.json`, and every built-in initiative with its members to `public/initiative-index.json`, both fetched by the custom assignment picker (`policyIndex.ts`). A custom assignment stores its policy's `info`, or an index initiative's `members` and the `infos` of members the catalog lacks (descriptions dropped); `withCustomPolicies` adds those to the catalog (`buildDesign`, `buildIacModel` and `App.tsx` all apply it).

**Engine** (`engine.ts`): `buildDesign(catalog, input)` → `Design`. It builds the management groups from ALZ archetypes (full or single platform; optional Corp, Online, Local, Confidential, Parking lot, Sandbox, Decommissioned), the ALZ assignments (toggled by decisions, enforcement posture applied), decision assignments (locations, tags, sovereignty, locked parking lot), one audit-only built-in initiative per framework, and a custom `Enforce-Framework-GR` initiative of Deny-capable framework policies. Custom assignments (`input.customAssignments`, origin `custom`) go in after the framework initiatives. Then it applies per-assignment overrides (keyed `<mg role>/<name>`: enforcement mode, removal, `notScopes`, parameters) and attaches exemptions. Coverage per framework and control comes after that, followed by policy rows, notes and PIM (`pim.ts`). In Azure Government it leaves out ALZ assignments and frameworks Government doesn't have, ALZ assignments with no policies left, and `ng` built-ins everywhere. MG IDs are `<prefix>` and `<prefix>-<role>`.

**IaC export** (`iac.ts`): `buildIacModel(design, catalog, library)` → `IacModel`. `generateIacFiles(format, model, options)` renders it, and every format comes from the same model. The templates (`toBicep`, the Bicep modules, `toTerraform`) are generic and take everything as data. The design goes in JSON (`lib/*.json` for Bicep, `design.auto.tfvars.json` for Terraform, `design.json` for Terragrunt). Per-environment values (`policy_values`: location, subscriptions, resource names, workspace/DNS/DDoS IDs, PIM group object IDs) go in a small values file. `inputs` lists them with placeholders; `unsetInputs` flags empty or ALZ-placeholder values. `aliases` repeat `platform_subscription_id` under the management and private DNS keys for a single platform subscription. The model also covers:
- ALZ custom definitions and initiatives, with their MG scope rewritten to the root
- assignment parameters with ALZ placeholders resolved to inputs or dropped
- remediation role assignments, plus cross-scope ones on the platform resource groups
- platform resources: the management RG with Log Analytics, solutions, three DCRs and the AMA identity, and the private DNS RG and zones
- exemptions at MG, subscription or resource group scope
- subscription placement, tenant hierarchy settings (the default MG is the parking lot), PIM, and manual-control overrides

Terraform needs `azurerm ~> 4.0` and `azapi ~> 2.0`; `azapi` is only for the tenant hierarchy settings. Its providers take `environment = var.cloud_environment` (`public` or `usgovernment`). Bicep deploys at tenant scope. PIM role settings can't be declared in Bicep, so the Bicep export adds `scripts/set-pim-policies.sh`, which reads each role management policy, edits its rules with `jq` and writes it back.

**Other modules:** `designs.ts` (saved designs: `DesignInput` plus `ExportSettings`, JSON backups, `migrateInput` fills new fields with defaults), `storage.ts` (`localStorage` keys prefixed `azure-governance-planner:`), `naming.ts` (region codes including Government; `<app>-<env>-<region>-<int>-<type>`), `privateDns.ts` (zone categories), `cloud.ts` (Government private DNS zone names), `families.ts` (control families per framework), `pim.ts` (PIM profiles, built-in and ALZ custom roles, control mappings), `uuid.ts` (UUID v5 for the custom roles' fixed IDs), `share.ts` (design links: changed decisions only, deflate-raw via CompressionStream, base64url in `#design=<version>.<z|j>.<data>`), `snapshot.ts` (one shape for a design or an Azure import: `designSnapshot`, `parseAzureImport` of the Resource Graph export from `AZURE_IMPORT_COMMANDS`; Resource Graph allows `policyresources` as a joined table only once per query, hence two queries) + `compare.ts` (policy overlap, assignment and management group differences, per-framework coverage of a snapshot), `report.ts` + `xlsx.ts` (the compliance report: sheets, plus "Compliance in Azure" when given an import with compliance state, and a dependency-free .xlsx writer on `zip.ts`; SheetJS reads its output), `migration.ts` (the plan from an Azure import to a design: `buildMigrationPlan`, `auditFirstDesign` for phase 2, `migrationMarkdown`; `toTerraformImports` in `iac.ts` turns its `existing` into import blocks: `imports.tf` for Terraform, `live/<env>/governance/imports.tf` for Terragrunt, which copies the working directory's files into the module it runs; `terraform validate` doesn't check import targets, only `plan` does), `cost.ts` (the cost estimate; `PRICES` are approximate list prices to keep up to date), `defender.ts` (the Defender plans, apart so `engine.ts` and `cost.ts` don't import each other), `baseline.ts` (what a saved design deployed when saved; `designChanges` compares it with what it deploys now).

**Adding a field to `DesignInput`:** give it a default in `DEFAULT_INPUT`. `migrateInput` merges stored and imported designs over the defaults, so older saved designs pick up the default value, which may not be what an old design intended.

## Facts and limits to remember

- **AzAdvertizer's Government data is unreliable for old policies.** Undated rows list only `AzureCloud` even when the policy is in Government (for example "Allowed locations"). `ng` is set only for dated rows. Treat Government availability as approximate.
- **Every Deny-capable built-in uses an `effect` parameter with `Deny` allowed.** Checked against the Azure CLI for all 144 framework candidates. Policies with a fixed effect show `n/a` as their allowed effects, and `canDeny` excludes them.
- **Overrides are capped.** Up to 50 reference IDs per override and 10 overrides per assignment (500 in all); the largest framework has 496 manual policies. Display names are limited to 128 characters, descriptions to 512, and MG-scope assignment names to 24.
- **ALZ library details.**
  - Custom initiatives reference custom policies under `managementGroups/contoso/`.
  - Assignments use `${default_location}` and `{enforcementMode}` (rendered "must" or "should").
  - A member's `ep` in the catalog is the initiative parameter its effect is wired to. Assignment parameters (the Defender plans, overrides) change those members' effects in the engine. Deploy-MDFC-Config's `enableAscFor<Plan>` parameters are the Defender plans; ALZ's assignment sets 12 of them to Disabled.
  - The private DNS initiative builds zone IDs from `dnsZoneSubscriptionId`, `dnsZoneResourceGroupName` and `dnsZoneRegion`. Its per-zone placeholder IDs are dropped.
- **Compliance state.** Query 3 summarizes `microsoft.policyinsights/policystates` per definition into synthetic `microsoft.policyinsights/policystatesummary` rows (distinct resources per state). Counts per control sum over its policies, so a resource can count more than once. Checked against the dev tenant: 169 definitions with state.
- **Untested against live services.** PIM couldn't be tested because the dev tenant isn't onboarded (it needs Entra ID P2). Azure Government exports were checked only with `terraform validate` and Bicep builds, not a Government plan.
- **Validated with real tools.** The Bicep DCRs, solutions, AMA identity and private DNS zones passed `az deployment group what-if` against `rg-azure-governance-planner` (read-only). Tenant-scope what-if needs rights the dev account doesn't have.
- **UI tests.** `jsdom` is a pinned dev dependency; UI test files start with `// @vitest-environment jsdom`, and the rest run in Node. Use `src/test/dom.tsx`: `click` dispatches an event because SVG elements have no `.click()`, `setValue` goes through the native value setter so React sees the change, and `until` waits for async work (share links, the ALZ library fetch, which tests stub with `public/alz-library.json`). It also polyfills `Blob.text()`; jsdom has neither that nor `Blob.arrayBuffer()`, so read blobs with `.text()`. Never put real tenant data in fixtures.

## Conventions

- Exact-pinned dependency versions in `package.json`.
- Add user-visible changes to `CHANGELOG.md` under the date (newest first, Added / Changed), in the same commit.
- Commit messages: a short imperative subject describing the user-visible change, with a body explaining what and why.
- Default resource names follow `<appName>-<environment>-<region>-<int>-<resourceType>` (for example `management-prd-eus2-01-log`), as `NAME_DEFAULTS` in `iac.ts` does; never hand-write names that bypass it.
- New UI behaviour gets a case in `App.ui.test.tsx`.
- New export behaviour needs tests in `iac.test.ts`, coverage in the "everything" sample, and a pass through the tool checks above.
