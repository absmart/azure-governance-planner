# Azure Governance Planner

Pick the compliance frameworks you need to meet (NIST SP 800-53, FedRAMP, CIS, PCI DSS, ISO 27001 and more) and a few governance decisions, and get a suggested Azure management group hierarchy and Azure Policy assignment design, with control coverage for each framework.

The design starts from the [Azure Landing Zones library](https://github.com/Azure/Azure-Landing-Zones-Library) and adds:

- each selected framework's built-in regulatory compliance initiative, in audit mode;
- a custom enforcement initiative of the framework's Deny-capable policies for landing zones (what-if or enforced, depending on the posture);
- assignments for decisions such as allowed locations, required tags and confidential landing zones.

## Control coverage

The **Control coverage** view rates every in-scope control: **Enforced** or **Audited** by policy, **PIM** (no policy evaluates it, but Privileged Identity Management addresses it), **Manual only**, **Excluded (manual)** (with "Exclude manual-only controls") or **No policy**. Controls whose policies don't apply everywhere, because of an excluded scope or an exemption, are marked **partly** with the reasons, and each framework shows how many there are.

**Compliance report** (top bar) downloads an Excel workbook for auditors: a summary with coverage per framework; every in-scope control with its status, "partly" exceptions, policies and PIM; every assignment with its mode, changes, excluded scopes and exemptions; every exemption with its reason, expiry and state (expired ones included); the overrides; and the privileged access settings, eligible groups and the controls PIM addresses.

## Privileged access

The **Privileged access** view puts Owner, User Access Administrator, Role Based Access Control Administrator and Contributor under Microsoft Entra **Privileged Identity Management**: named groups are eligible for a role at a management group and activate it just in time, and every management group gets the same role settings. The profile comes from the selected frameworks (High for FedRAMP High, NIST 800-53 High, CMMC and CJIS; Standard otherwise) or is chosen:

| | Standard | High |
| --- | --- | --- |
| Longest activation | 8 hours | 4 hours |
| Activation requires | MFA, justification | MFA, justification, ticket number |
| Approval | Owner, User Access Administrator, RBAC Administrator | all four roles |
| Eligible assignments expire after | 365 days | 180 days |
| Active assignments expire after | 15 days | 15 days |
| Access reviews (set up in Entra ID) | quarterly | monthly |

ALZ's custom roles (Application Owners, Network Management, Network Subnet Contributor, Security Operations, Subscription Owner) are defined at the top management group (a Guardrails option, on by default) and can be added to PIM, so groups can be made eligible for them too; they need approval in the High profile.

The view lists the controls this helps address (NIST 800-53 AC-2(6), AC-2(7), AC-6(5), AC-6(7), IA-2(1), AC-2(4); NIST 800-171; CMMC; MCSB PA-1, PA-2, PA-4; ISO 27001; PCI DSS; SOC 2). Terraform sets the role settings and eligible assignments with `azurerm_role_management_policy` and `azurerm_pim_eligible_role_assignment`; Bicep creates the eligible assignments and `scripts/set-pim-policies.sh` (az CLI and jq) sets the role settings. The groups' and the approver's Entra ID object IDs are per-environment values. PIM needs Entra ID P2 or Entra ID Governance.

**Share** (top bar) makes a link that carries the design itself, deflate-compressed after the `#`, so nothing is uploaded or stored anywhere: only the decisions that differ from the defaults go in, so links stay short (a FedRAMP High design with an override and an exemption is under 800 characters). The export's environment values (subscription and group object IDs) are left out unless you include them. Opening a link loads the design as the current, unsaved one, to change and save.

## Compare, and import from Azure

The **Compare** view puts any two of these side by side: the current design, a saved design, or a tenant imported from Azure.

- **Import from Azure** gives a read-only Azure Resource Graph command (bash or PowerShell, through `az rest`, so no CLI extension is needed) that saves the management groups, policy assignments and exemptions you can see, with the custom definitions and the assigned built-in ones, to `azure-policy.json`. Or, without the CLI, run the same two queries in the portal's **Resource Graph Explorer** (with **Format results** off) and choose both **Download as CSV** files. Paste or upload it; each assignment's policies and effects are resolved from its initiative, parameters and overrides.
- **Policies in effect** shows a Venn diagram of the policies each side evaluates (or only enforces), and lists those only in A, in both, only in B, or enforced on one side only.
- **Framework coverage** rates each side by its policies alone against any framework (enforced, audited, manual only, not assigned, no policy) and lists the controls rated differently.
- **Assignments** are matched by definition (built-in ID, or custom name without an ALZ version suffix) and show where scope or enforcement differs; **management groups** are matched by ID.

Microsoft's hidden system assignments (`sys.*`) are left out unless you ask for them.

## Saved designs

**Designs** keeps named designs in the browser: save (Ctrl+S), save as new, open, duplicate, rename and delete. A design holds every decision, including overrides and exemptions, plus the IaC export settings (format, environment and values). Export one or all of them to a `.json` file to back them up, share them or move them to another machine, and import them again from the same dialog.

## Export to infrastructure as code

**Export IaC** turns the current design into Bicep, Terraform or Terragrunt. Each export has:

- a generic template (`main.bicep` / `main.tf`) that creates the management groups, the custom policy definitions and initiatives, the assignments (with their enforcement modes, parameters and non-compliance messages) and the role assignments the remediation identities need;
- the design as data (JSON), including the ALZ custom definitions it uses from the pinned ALZ library release;
- the platform resources ALZ's DeployIfNotExists policies point at: in the management subscription, a resource group with the Log Analytics workspace, the data collection rules (VM Insights, Change Tracking, Defender for SQL) and the Azure Monitor Agent identity; in the connectivity subscription, the private DNS zone resource group with the commonly used private link zones, linked to the hub virtual networks you list (`private_dns_virtual_network_ids`) (storage, Container Apps, Azure SQL, Key Vault, Container Registry, App Service and Azure Monitor by default; more categories in the decisions panel). Remediation identities get their roles on those resource groups too;
- a small values file per environment: the region, the subscriptions, the resource names (default `<app>-<environment>-<region>-<int>-<type>`, for example `management-prd-eus2-01-log`) and the remaining existing resources (security contact, and the DDoS plan if DDoS Network Protection is turned on; it's off by default because a plan costs about US$2,944 a month). The dialog flags any still empty or at the ALZ placeholder.

**Defender plans** (shown under the Defender for Cloud guardrail) choose which Defender for Cloud plans ALZ's Deploy-MDFC-Config assignment turns on. ALZ's own assignment ships most plans Disabled; the design sets every plan explicitly, with all plans on by default except Defender CSPM and AI services. Coverage follows the plans, and a parameter override of an `enableAscFor…` value changes the matching policies' effects too.

**Exclude manual-only controls** (a decision next to the frameworks, also shown in the export dialog) keeps the built-in regulatory compliance initiatives but turns off their manual-attestation policies with assignment overrides (effect Disabled, up to 50 reference IDs per override and 10 overrides per assignment, which fits every framework). Controls that only manual policies cover then aren't evaluated or listed as needing evidence; controls with automated policies keep them.

For **Azure Government**, the export uses Government private DNS zone names (and sets them on ALZ's private DNS policy), targets the `usgovernment` cloud in Terraform, and leaves out built-in policies Azure Government doesn't have, per AzAdvertizer's availability data. In the app, each assignment can be **overridden** (enforcement mode, removal, excluded scopes, parameters) and **exempted**, wholly or for chosen policies, at a management group, subscription or resource group; both are part of the export.

With a **parking lot** (on by default, under Management groups in the decisions panel), new subscriptions land in a Parking lot management group instead of the tenant root group: the export sets the tenant's default management group to it (and, optionally, requires permission to create management groups). By default the parking lot is **locked**: a custom policy (mode All, so resource groups and subscription resources too) denies every deployment apart from the platform's security baseline (Defender for Cloud, activity log), so a subscription can only be moved in or out until someone places it. It can instead carry the Sandbox guardrails, or only inherit the root's. Terraform uses the `azapi` provider for the tenant setting.

Deploying needs tenant-level rights (Owner at the tenant root management group, or equivalent). See the README in each export.

To write sample exports for `az bicep build` and `terraform validate`, run `IAC_OUT_DIR=<dir> npm test`.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

## Deploy

The app is hosted on Azure Static Web Apps (`swa-azure-governance-planner` in resource group `rg-azure-governance-planner`, https://lemon-coast-0a2a7820f.2.azurestaticapps.net). Every push to `main` deploys to production: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the tests, builds and uploads `dist/`, using the repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. A failing test stops the deploy.

To deploy by hand from a machine with a logged-in Azure CLI:

```sh
npm run build
export SWA_CLI_DEPLOYMENT_TOKEN=$(az staticwebapp secrets list -n swa-azure-governance-planner -g rg-azure-governance-planner --query properties.apiKey -o tsv)
npx --yes @azure/static-web-apps-cli@2.0.2 deploy ./dist --env production
```

## Policy data

`src/data/catalog.json` and `public/alz-library.json` (the ALZ definitions and assignment parameters, loaded only when exporting) are committed snapshots built by `npm run update-catalog` from:

- [Azure/azure-policy](https://github.com/Azure/azure-policy) built-in initiatives
- the [Azure Landing Zones library](https://github.com/Azure/Azure-Landing-Zones-Library) archetypes, assignments and custom definitions, pinned to a release (`ALZ_REF` in the script)
- [AzAdvertizer](https://www.azadvertizer.net) policy metadata
- [NIST OSCAL content](https://github.com/usnistgov/oscal-content) for SP 800-53 control titles and SP 800-53B baselines

Every Monday, [.github/workflows/update-catalog.yml](.github/workflows/update-catalog.yml) moves `ALZ_REF` to the latest ALZ library release, re-runs the script, tests and builds, and opens a pull request (`automated/update-catalog`) summarizing what changed, when anything did. Merging it deploys the app. It can also be run by hand from the Actions tab, and `node scripts/catalog-diff.mjs <old> <new>` prints the same summary locally.
