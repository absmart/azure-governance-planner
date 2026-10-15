// Defender for Cloud plans a design can turn on. On its own so the engine and the
// cost estimate can both use it without importing each other.

/**
 * Defender for Cloud plans, by the Deploy-MDFC-Config initiative parameter
 * that turns each on (enableAscFor<key>). ALZ's own assignment switches most
 * of them to Disabled; the design sets every one explicitly.
 */
export const DEFENDER_PLANS: { key: string; label: string; help: string; default: boolean }[] = [
  { key: 'Servers', label: 'Servers', help: 'Defender for Servers on VMs and Arc machines.', default: true },
  { key: 'ServersVulnerabilityAssessments', label: 'Servers vulnerability assessment', help: 'Built-in vulnerability scanning on servers.', default: true },
  { key: 'Sql', label: 'Azure SQL', help: 'Azure SQL Database and Managed Instance.', default: true },
  { key: 'SqlOnVm', label: 'SQL servers on machines', help: 'SQL Server on VMs and Arc.', default: true },
  { key: 'OssDb', label: 'Open-source databases', help: 'PostgreSQL, MySQL and MariaDB.', default: true },
  { key: 'CosmosDbs', label: 'Cosmos DB', help: 'Azure Cosmos DB accounts.', default: true },
  { key: 'AppServices', label: 'App Service', help: 'Web apps and functions on App Service.', default: true },
  { key: 'Storage', label: 'Storage', help: 'Storage accounts (Defender for Storage).', default: true },
  { key: 'Containers', label: 'Containers', help: 'AKS, container registries and the Azure Policy add-on for Kubernetes.', default: true },
  { key: 'KeyVault', label: 'Key Vault', help: 'Key vaults.', default: true },
  { key: 'Arm', label: 'Resource Manager', help: 'Control-plane operations on subscriptions.', default: true },
  { key: 'Cspm', label: 'Defender CSPM', help: 'Premium posture management (attack paths, agentless scanning). Billed per resource, so off by default.', default: false },
  { key: 'AI', label: 'AI services', help: 'Threat protection for Azure OpenAI and AI services. Off by default; turn on where AI workloads run.', default: false },
];
export const DEFAULT_DEFENDER_PLANS = DEFENDER_PLANS.filter((p) => p.default).map((p) => p.key);
