# Azure Governance Planner

Pick the compliance frameworks you need to meet (NIST SP 800-53, FedRAMP, CIS, PCI DSS, ISO 27001 and more) and a few governance decisions, and get a suggested Azure management group hierarchy and Azure Policy assignment design, with control coverage for each framework.

The design starts from the [Azure Landing Zones library](https://github.com/Azure/Azure-Landing-Zones-Library) and adds:

- each selected framework's built-in regulatory compliance initiative, in audit mode;
- a custom enforcement initiative of the framework's Deny-capable policies for landing zones (what-if or enforced, depending on the posture);
- assignments for decisions such as allowed locations, required tags and confidential landing zones.

## Export to infrastructure as code

**Export IaC** turns the current design into Bicep, Terraform or Terragrunt. Each export has:

- a generic template (`main.bicep` / `main.tf`) that creates the management groups, the custom policy definitions and initiatives, the assignments (with their enforcement modes, parameters and non-compliance messages) and the role assignments the remediation identities need;
- the design as data (JSON), including the ALZ custom definitions it uses from the pinned ALZ library release;
- a small values file per environment: the region and the resource IDs ALZ's DeployIfNotExists policies point at (Log Analytics workspace, data collection rules, DDoS plan, private DNS zones, security contact). The dialog flags any still at the ALZ placeholder.

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

Re-run it to pick up new built-in policies and ALZ library releases.
