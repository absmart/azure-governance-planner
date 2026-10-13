// Commonly used Azure private link DNS zones, by service category. Names match
// the zones ALZ's Deploy-Private-DNS-Zones initiative registers records in
// where it covers the service. {regionName} is the private DNS zone region.

export interface PrivateDnsCategory {
  key: string;
  label: string;
  zones: string[];
}

export const PRIVATE_DNS_CATEGORIES: PrivateDnsCategory[] = [
  {
    key: 'storage',
    label: 'Storage accounts',
    zones: [
      'privatelink.blob.core.windows.net',
      'privatelink.file.core.windows.net',
      'privatelink.queue.core.windows.net',
      'privatelink.table.core.windows.net',
      'privatelink.dfs.core.windows.net',
      'privatelink.web.core.windows.net',
    ],
  },
  { key: 'containerApps', label: 'Container Apps', zones: ['privatelink.{regionName}.azurecontainerapps.io'] },
  { key: 'sql', label: 'Azure SQL', zones: ['privatelink.database.windows.net'] },
  { key: 'keyVault', label: 'Key Vault', zones: ['privatelink.vaultcore.azure.net'] },
  {
    key: 'containerRegistry',
    label: 'Container Registry',
    zones: ['privatelink.azurecr.io', '{regionName}.data.privatelink.azurecr.io'],
  },
  { key: 'appService', label: 'App Service and Functions', zones: ['privatelink.azurewebsites.net'] },
  {
    key: 'monitor',
    label: 'Azure Monitor (Private Link Scope)',
    zones: [
      'privatelink.monitor.azure.com',
      'privatelink.oms.opinsights.azure.com',
      'privatelink.ods.opinsights.azure.com',
      'privatelink.agentsvc.azure-automation.net',
      'privatelink.blob.core.windows.net',
    ],
  },
  { key: 'aks', label: 'AKS (private clusters)', zones: ['privatelink.{regionName}.azmk8s.io'] },
  { key: 'cosmosDb', label: 'Cosmos DB (NoSQL)', zones: ['privatelink.documents.azure.com'] },
  {
    key: 'openSourceDatabases',
    label: 'PostgreSQL and MySQL',
    zones: ['privatelink.postgres.database.azure.com', 'privatelink.mysql.database.azure.com'],
  },
  { key: 'messaging', label: 'Event Hubs and Service Bus', zones: ['privatelink.servicebus.windows.net'] },
  {
    key: 'ai',
    label: 'Azure OpenAI, AI services and AI Search',
    zones: ['privatelink.openai.azure.com', 'privatelink.cognitiveservices.azure.com', 'privatelink.search.windows.net'],
  },
];

/** Selected by default: the services most landing zones put behind private endpoints. */
export const DEFAULT_PRIVATE_DNS_CATEGORIES = ['storage', 'containerApps', 'sql', 'keyVault', 'containerRegistry', 'appService', 'monitor'];

/** The zones of the selected categories for a region, without duplicates. */
export function privateDnsZones(categories: string[], region: string): string[] {
  const zones = PRIVATE_DNS_CATEGORIES.filter((c) => categories.includes(c.key)).flatMap((c) => c.zones);
  const name = region.trim() === '{regionName}' ? region.trim() : region.trim().toLowerCase() || 'eastus2';
  return [...new Set(zones.map((z) => z.replace('{regionName}', name)))];
}
