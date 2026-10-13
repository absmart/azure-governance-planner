// Azure Government differences the IaC export needs: private link DNS zone
// names. Mappings from Microsoft's "Azure Private Endpoint private DNS zone
// values" (Government tab); services Azure Government doesn't offer keep a
// best-guess name, which does no harm as nothing registers records in them.

/** Zones whose Government name doesn't follow the suffix rules below. */
const GOV_EXACT: Record<string, string> = {
  'privatelink.vaultcore.azure.net': 'privatelink.vaultcore.usgovcloudapi.net',
  'privatelink.search.windows.net': 'privatelink.search.azure.us',
  'privatelink.{regionName}.azmk8s.io': 'privatelink.{regionName}.cx.aks.containerservice.azure.us',
  'privatelink.azure-automation.net': 'privatelink.azure-automation.us',
  'privatelink.agentsvc.azure-automation.net': 'privatelink.agentsvc.azure-automation.us',
  'privatelink.afs.azure.net': 'privatelink.afs.usgovcloudapi.net',
  'privatelink.media.azure.net': 'privatelink.media.usgovcloudapi.net',
  'privatelink.notebooks.azure.net': 'privatelink.notebooks.usgovcloudapi.net',
  'privatelink.batch.azure.com': 'privatelink.batch.usgovcloudapi.net',
  'privatelink.api.azureml.ms': 'privatelink.api.ml.azure.us',
  'privatelink.azuredatabricks.net': 'privatelink.databricks.azure.us',
  'privatelink.service.signalr.net': 'privatelink.signalr.azure.us',
  'privatelink.wvd.microsoft.com': 'privatelink.wvd.azure.us',
  'privatelink.azconfig.io': 'privatelink.azconfig.azure.us',
  'privatelink.directline.botframework.com': 'privatelink.directline.botframework.azure.us',
};

/** Commercial suffix → Government suffix, most specific first. */
const GOV_SUFFIXES: [string, string][] = [
  ['.database.azure.com', '.database.usgovcloudapi.net'],
  ['.azuresynapse.net', '.azuresynapse.usgovcloudapi.net'],
  ['.windowsazure.com', '.windowsazure.us'],
  ['.windows.net', '.usgovcloudapi.net'],
  ['.azurecr.io', '.azurecr.us'],
  ['.azurewebsites.net', '.azurewebsites.us'],
  ['.azurecontainerapps.io', '.azurecontainerapps.us'],
  ['.azure-devices-provisioning.net', '.azure-devices-provisioning.us'],
  ['.azure-devices.net', '.azure-devices.us'],
  ['.azurehdinsight.net', '.azurehdinsight.us'],
  ['.azure.com', '.azure.us'],
  ['.azure.net', '.azure.us'],
];

/** The Azure Government name of a commercial private link DNS zone. */
export function govZoneName(zone: string): string {
  if (GOV_EXACT[zone]) return GOV_EXACT[zone];
  for (const [commercial, gov] of GOV_SUFFIXES) if (zone.endsWith(commercial)) return zone.slice(0, -commercial.length) + gov;
  return zone;
}
