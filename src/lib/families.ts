// Groups a framework's controls into families (NIST control families, CIS
// sections, PCI requirements, ...) for the coverage view.

const NIST_800_171: Record<string, string> = {
  '3.1': 'Access Control',
  '3.2': 'Awareness and Training',
  '3.3': 'Audit and Accountability',
  '3.4': 'Configuration Management',
  '3.5': 'Identification and Authentication',
  '3.6': 'Incident Response',
  '3.7': 'Maintenance',
  '3.8': 'Media Protection',
  '3.9': 'Personnel Security',
  '3.10': 'Physical Protection',
  '3.11': 'Risk Assessment',
  '3.12': 'Security Assessment',
  '3.13': 'System and Communications Protection',
  '3.14': 'System and Information Integrity',
};

const CSF: Record<string, string> = {
  GV: 'Govern',
  ID: 'Identify',
  PR: 'Protect',
  DE: 'Detect',
  RS: 'Respond',
  RC: 'Recover',
};

const MCSB: Record<string, string> = {
  NS: 'Network security',
  IM: 'Identity management',
  PA: 'Privileged access',
  DP: 'Data protection',
  AM: 'Asset management',
  LT: 'Logging and threat detection',
  IR: 'Incident response',
  PV: 'Posture and vulnerability management',
  ES: 'Endpoint security',
  BR: 'Backup and recovery',
  DS: 'DevOps security',
  GS: 'Governance and strategy',
};

const CIS_AZURE_2: Record<string, string> = {
  '1': 'Identity and Access Management',
  '2': 'Microsoft Defender',
  '3': 'Storage Accounts',
  '4': 'Database Services',
  '5': 'Logging and Monitoring',
  '6': 'Networking',
  '7': 'Virtual Machines',
  '8': 'Key Vault',
  '9': 'App Service',
};

const PCI: Record<string, string> = {
  '1': 'Network security controls',
  '2': 'Secure configurations',
  '3': 'Protect stored account data',
  '4': 'Protect data in transit',
  '5': 'Protect against malware',
  '6': 'Secure systems and software',
  '7': 'Restrict access by need to know',
  '8': 'Identify users and authenticate access',
  '9': 'Restrict physical access',
  '10': 'Log and monitor access',
  '11': 'Test security regularly',
  '12': 'Policies and programs',
};

const SOC2: Record<string, string> = {
  CC: 'Common criteria (security)',
  A: 'Availability',
  C: 'Confidentiality',
  PI: 'Processing integrity',
  P: 'Privacy',
};

const HITRUST: Record<string, string> = {
  '00': 'Information Security Management Program',
  '01': 'Access Control',
  '02': 'Human Resources Security',
  '03': 'Risk Management',
  '04': 'Security Policy',
  '05': 'Organization of Information Security',
  '06': 'Compliance',
  '07': 'Asset Management',
  '08': 'Physical and Environmental Security',
  '09': 'Communications and Operations Management',
  '10': 'Information Systems Acquisition, Development and Maintenance',
  '11': 'Information Security Incident Management',
  '12': 'Business Continuity Management',
  '13': 'Privacy Practices',
};

export interface Family {
  code: string;
  title: string;
}

/** The family a control belongs to, given the framework's key. */
export function familyOf(frameworkKey: string, control: string, nistFamilies: Record<string, string>): Family {
  const first = (re: RegExp) => re.exec(control)?.[1] ?? control;
  switch (frameworkKey) {
    case 'nist-800-53-r5':
    case 'fedramp-high':
    case 'fedramp-moderate': {
      const code = first(/^([A-Z]{2})-/);
      return { code, title: nistFamilies[code] ?? code };
    }
    case 'cmmc-2-l2': {
      const code = first(/^([A-Z]{2})\./);
      return { code, title: nistFamilies[code] ?? code };
    }
    case 'nist-800-171-r2': {
      const code = first(/^(\d+\.\d+)/);
      return { code, title: NIST_800_171[code] ?? code };
    }
    case 'nist-csf-2': {
      const code = first(/^([A-Z]{2})/);
      return { code, title: CSF[code] ?? code };
    }
    case 'mcsb': {
      const code = first(/^([A-Z]{2})-/);
      return { code, title: MCSB[code] ?? code };
    }
    case 'cis-azure-2': {
      const code = first(/^(\d+)/);
      return { code, title: CIS_AZURE_2[code] ?? `Section ${code}` };
    }
    case 'pci-dss-4': {
      const code = first(/^(\d+)/);
      return { code, title: PCI[code] ? `Req. ${code}: ${PCI[code]}` : `Requirement ${code}` };
    }
    case 'soc2': {
      const code = first(/^([A-Z]+)/);
      return { code, title: SOC2[code] ?? code };
    }
    case 'hipaa-hitrust': {
      const code = first(/(\d{2})\.[a-z]$/);
      return { code, title: HITRUST[code] ?? 'Other' };
    }
    case 'gdpr':
    case 'nis2':
      return { code: control, title: `Article ${control}` };
    case 'iso-27001-2022':
      return { code: first(/^(\d+)/), title: `Clause ${first(/^(\d+)/)}` };
    default: {
      const code = first(/^([A-Za-z]+|\d+)/);
      return { code, title: /^\d+$/.test(code) ? `Section ${code}` : code };
    }
  }
}

/** Short label for long control IDs (HITRUST refs carry the objective name). */
export function controlLabel(frameworkKey: string, control: string): string {
  if (frameworkKey === 'hipaa-hitrust') {
    const m = /^hipaa-(\d+)\.(\w+?)(\d?)(Organizational|System|Regulatory)\.(.+)$/.exec(control);
    if (m) return `${m[5]} (${m[1]})`;
  }
  return control;
}
