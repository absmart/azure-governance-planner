# Azure Governance Planner

Pick the compliance frameworks you need to meet (NIST SP 800-53, FedRAMP, CIS, PCI DSS, ISO 27001 and more) and a few governance decisions, and get a suggested Azure management group hierarchy and Azure Policy assignment design, with control coverage for each framework.

The design starts from the [Azure Landing Zones library](https://github.com/Azure/Azure-Landing-Zones-Library) and adds:

- each selected framework's built-in regulatory compliance initiative, in audit mode;
- a custom enforcement initiative of the framework's Deny-capable policies for landing zones (what-if or enforced, depending on the posture);
- assignments for decisions such as allowed locations, required tags and confidential landing zones.

Generating deployment code is planned but not built yet.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

## Policy data

`src/data/catalog.json` is a committed snapshot built by `npm run update-catalog` from:

- [Azure/azure-policy](https://github.com/Azure/azure-policy) built-in initiatives
- the [Azure Landing Zones library](https://github.com/Azure/Azure-Landing-Zones-Library) archetypes and assignments
- [AzAdvertizer](https://www.azadvertizer.net) policy metadata
- [NIST OSCAL content](https://github.com/usnistgov/oscal-content) for SP 800-53 control titles and SP 800-53B baselines

Re-run it to pick up new built-in policies and ALZ library releases.
