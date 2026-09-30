---
id: sec-siem-log-hunt
title: Security: Cloud SIEM, Kubernetes & eBPF Stealth APT Threat Hunt
category: security
language: null
functionName: solution
executable: false
---
Act as a Principal Detection & Incident Response Lead (DFIR / Threat Hunter) investigating an anomalous alert stream in a PCI-DSS Level 1 cloud environment (`fin-prod` on GCP + GKE).

Below is a **32-event multi-source telemetry correlation feed** captured between `01:10:00Z` and `02:00:00Z` across **6 telemetry planes**:
- `[CLB-HTTP]` Cloud Load Balancer / Envoy Ingress Access Logs
- `[EBPF-TETRAGON]` Kernel eBPF `execve`, `tcp_connect`, and `sys_setns` Telemetry
- `[GCP-IAM-AUDIT]` GCP Cloud Audit Logs (IAM, Compute, Storage, KMS)
- `[K8S-AUDIT]` GKE Kubernetes API Server Audit Logs
- `[CLOUD-DNS]` VPC Cloud DNS Query Telemetry
- `[VPC-FLOW]` VPC Egress Flow Logs

> **THREAT HUNT BRIEFING**:
> The telemetry stream contains **2 high-volume Benign / Red-Herring Noise Streams** mixed with a **stealthy 6-stage Advanced Persistent Threat (APT) intrusion** that progresses from an application-layer SSRF all the way to a Kubernetes container escape, Cloud KMS master-key decryption, and covert exfiltration.

---

### Raw Multi-Source Telemetry Stream (`2026-09-30T01:10:00Z` – `01:55:00Z`)

```text
[01] 2026-09-30T01:10:04.112Z [CLB-HTTP] src=198.51.100.214 asn=AS14061 method=GET path="/wp-login.php" status=404 latency_ms=3 ua="Nuclei - Open-source project (github.com/projectdiscovery/nuclei)" backend="checkout-graphql"
[02] 2026-09-30T01:10:04.419Z [CLB-HTTP] src=198.51.100.214 asn=AS14061 method=GET path="/.git/config" status=404 latency_ms=2 ua="Nuclei - Open-source project" backend="checkout-graphql"
[03] 2026-09-30T01:10:05.008Z [CLB-HTTP] src=198.51.100.214 asn=AS14061 method=GET path="/.env" status=403 latency_ms=1 ua="Nuclei - Open-source project" backend="checkout-graphql"
[04] 2026-09-30T01:10:05.890Z [CLB-HTTP] src=198.51.100.214 asn=AS14061 method=GET path="/actuator/heapdump" status=404 latency_ms=2 ua="Nuclei - Open-source project" backend="checkout-graphql"
[05] 2026-09-30T01:12:14.205Z [CLB-HTTP] src=45.155.205.91 asn=AS49453 method=POST path="/api/v2/graphql?op=resolveShippingCarrierPreview" status=200 latency_ms=4890 bytes_out=1842 ua="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)" pod="checkout-graphql-7d9c8b-x4k2"
[06] 2026-09-30T01:12:15.011Z [EBPF-TETRAGON] node="gke-prod-pool-02-19c4" pod="checkout-graphql-7d9c8b-x4k2" pid=4182 comm="node" event="tcp_connect" dst_ip="169.254.169.254" dst_port=80 http_hdr="Metadata-Flavor: Google" uri="/computeMetadata/v1/instance/service-accounts/default/token"
[07] 2026-09-30T01:12:16.330Z [EBPF-TETRAGON] node="gke-prod-pool-02-19c4" pod="checkout-graphql-7d9c8b-x4k2" pid=4182 comm="node" event="tcp_connect" dst_ip="169.254.169.254" dst_port=80 http_hdr="Metadata-Flavor: Google" uri="/computeMetadata/v1/project/attributes/ssh-keys"
[08] 2026-09-30T01:15:00.004Z [GCP-IAM-AUDIT] principal="tf-drift-checker-sa@fin-prod.iam.gserviceaccount.com" src=34.71.19.88 asn=AS15169(Google-Cloud-NAT) method="compute.instances.list" resource="projects/fin-prod" status=200 ua="Terraform/1.8.2 (+https://www.terraform.io) terraform-provider-google/5.28.0"
[09] 2026-09-30T01:15:01.118Z [GCP-IAM-AUDIT] principal="tf-drift-checker-sa@fin-prod.iam.gserviceaccount.com" src=34.71.19.88 asn=AS15169(Google-Cloud-NAT) method="storage.buckets.getIamPolicy" resource="projects/_/buckets/fin-prod-cardholder-vault" status=200 ua="Terraform/1.8.2"
[10] 2026-09-30T01:21:08.442Z [GCP-IAM-AUDIT] principal="checkout-worker-sa@fin-prod.iam.gserviceaccount.com" src=185.220.101.33 asn=AS205100(F3Netze-Tor-Exit) method="iam.serviceAccounts.list" resource="projects/fin-prod" status=200 ua="gcloud-python/1.14.0"
[11] 2026-09-30T01:21:19.903Z [GCP-IAM-AUDIT] principal="checkout-worker-sa@fin-prod.iam.gserviceaccount.com" src=185.220.101.33 asn=AS205100(F3Netze-Tor-Exit) method="iam.serviceAccounts.getAccessToken" resource="projects/-/serviceAccounts/gke-node-debug-sa@fin-prod.iam.gserviceaccount.com" status=200 delegated_chain="checkout-worker-sa"
[12] 2026-09-30T01:24:11.600Z [K8S-AUDIT] user="system:node:gke-prod-pool-04-88a1" src=10.128.15.44 verb="create" resource="certificatesigningrequests" subresource="nodeclient" status=201 reason="KubeletRotateClientCert"
[13] 2026-09-30T01:26:02.115Z [K8S-AUDIT] user="gke-node-debug-sa@fin-prod.iam.gserviceaccount.com" src=185.220.101.33 verb="list" namespace="kube-system" resource="pods" status=200 ua="kubectl/v1.30.1 (linux/amd64)"
[14] 2026-09-30T01:26:41.782Z [K8S-AUDIT] user="gke-node-debug-sa@fin-prod.iam.gserviceaccount.com" src=185.220.101.33 verb="patch" namespace="kube-system" resource="pods" name="node-exporter-9f2m" subresource="ephemeralcontainers" node="gke-prod-pool-04-88a1" image="gcr.io/fin-prod/netshoot-debug:latest" target_container="exporter" status=200
[15] 2026-09-30T01:27:03.094Z [EBPF-TETRAGON] node="gke-prod-pool-04-88a1" pod="kube-system/node-exporter-9f2m" container="debugger-7xk" pid=19402 ppid=19388 uid=0 host_pid_ns=true event="execve" binary="/usr/bin/nsenter" args="nsenter -t 1 -m -u -i -n -p -- /bin/sh"
[16] 2026-09-30T01:27:04.210Z [EBPF-TETRAGON] node="gke-prod-pool-04-88a1" pod="kube-system/node-exporter-9f2m" pid=19402 event="sys_setns" target_ns="mnt:[4026531840],pid:[4026531836],net:[4026531992]" target_pid=1 result=0
[17] 2026-09-30T01:27:19.551Z [EBPF-TETRAGON] node="gke-prod-pool-04-88a1" host_ns=true pid=19440 ppid=19402 uid=0 event="execve" binary="/bin/sh" args="sh -c grep -rn 'Bearer ' /var/lib/kubelet/pods/*/volumes/kubernetes.io~projected/ /proc/*/environ 2>/dev/null"
[18] 2026-09-30T01:28:05.880Z [CLB-HTTP] src=198.51.100.214 asn=AS14061 method=GET path="/phpmyadmin/index.php" status=404 latency_ms=1 ua="Nuclei - Open-source project" backend="checkout-graphql"
[19] 2026-09-30T01:28:06.102Z [CLB-HTTP] src=198.51.100.214 asn=AS14061 method=GET path="/server-status" status=404 latency_ms=1 ua="Nuclei - Open-source project" backend="checkout-graphql"
[20] 2026-09-30T01:30:00.012Z [GCP-IAM-AUDIT] principal="tf-drift-checker-sa@fin-prod.iam.gserviceaccount.com" src=34.71.19.88 asn=AS15169(Google-Cloud-NAT) method="compute.instances.list" resource="projects/fin-prod" status=200 ua="Terraform/1.8.2"
[21] 2026-09-30T01:30:01.340Z [GCP-IAM-AUDIT] principal="tf-drift-checker-sa@fin-prod.iam.gserviceaccount.com" src=34.71.19.88 asn=AS15169(Google-Cloud-NAT) method="storage.buckets.getIamPolicy" resource="projects/_/buckets/fin-prod-cardholder-vault" status=200 ua="Terraform/1.8.2"
[22] 2026-09-30T01:34:19.008Z [GCP-IAM-AUDIT] principal="vault-unsealer-sa@fin-prod.iam.gserviceaccount.com" src=35.224.88.12(gke-prod-pool-04-88a1) method="storage.objects.get" resource="projects/_/buckets/fin-prod-cardholder-vault/objects/exports/pan_shard_2026_09.enc" bytes_transferred=48291840 status=200
[23] 2026-09-30T01:35:02.671Z [GCP-IAM-AUDIT] principal="vault-unsealer-sa@fin-prod.iam.gserviceaccount.com" src=35.224.88.12(gke-prod-pool-04-88a1) method="cloudkms.projects.locations.keyRings.cryptoKeys.decrypt" resource="projects/fin-prod/locations/us-central1/keyRings/vault/cryptoKeys/master-pii-key" status=200
[24] 2026-09-30T01:36:11.402Z [EBPF-TETRAGON] node="gke-prod-pool-04-88a1" host_ns=true pid=19612 ppid=19402 uid=0 event="execve" binary="/usr/bin/python3" args="python3 -c import zlib,binascii,socket; data=open('/dev/shm/.pan_clear','rb').read(); ..."
[25] 2026-09-30T01:36:45.900Z [VPC-FLOW] src=10.128.15.44(gke-prod-pool-04-88a1) dst=185.220.101.33 dst_port=443 proto=TCP action=DENIED_EGRESS_FIREWALL rule="deny-all-unlisted-egress"
[26] 2026-09-30T01:38:10.005Z [CLOUD-DNS] src_node="gke-prod-pool-04-88a1" qtype=TXT qname="0001.8f9a2b4c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e.telemetry-sync.edge-cdn-verify.com." rcode=NOERROR ans_len=12
[27] 2026-09-30T01:38:10.250Z [CLOUD-DNS] src_node="gke-prod-pool-04-88a1" qtype=TXT qname="0002.4e6f8a1b3c5d7e9f0a2b4c6d8e8f9a2b4c1d3e5f7a9b0c2d.telemetry-sync.edge-cdn-verify.com." rcode=NOERROR ans_len=12
[28] 2026-09-30T01:38:10.510Z [CLOUD-DNS] src_node="gke-prod-pool-04-88a1" qtype=TXT qname="0003.9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e8f9a2b4c1d3e5f7a.telemetry-sync.edge-cdn-verify.com." rcode=NOERROR ans_len=12
[29] 2026-09-30T01:45:00.009Z [GCP-IAM-AUDIT] principal="tf-drift-checker-sa@fin-prod.iam.gserviceaccount.com" src=34.71.19.88 asn=AS15169(Google-Cloud-NAT) method="compute.instances.list" resource="projects/fin-prod" status=200 ua="Terraform/1.8.2"
[30] 2026-09-30T01:54:40.881Z [CLOUD-DNS] src_node="gke-prod-pool-04-88a1" qtype=TXT qname="1420.7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e8f9a2b4c1d3e5f.telemetry-sync.edge-cdn-verify.com." rcode=NOERROR summary="1420 TXT queries between 01:38:10Z and 01:54:40Z"
[31] 2026-09-30T01:54:52.103Z [EBPF-TETRAGON] node="gke-prod-pool-04-88a1" host_ns=true pid=19980 ppid=19402 uid=0 event="execve" binary="/usr/bin/shred" args="shred -u -z /dev/shm/.pan_clear"
[32] 2026-09-30T01:55:00.002Z [K8S-AUDIT] user="system:serviceaccount:kube-system:cronjob-controller" verb="create" namespace="fin-batch" resource="jobs" name="hourly-settlement-reconcile-28791" status=201
```

---

### Required Deliverables

Produce a structured, publishable **DFIR Threat Hunt & Containment Report** in clean Markdown with the following 5 sections:

1. **Section 1: Benign Noise & Red-Herring Elimination Table**
   - Identify every non-malicious or unexploited commodity noise event in the 32-line feed (referencing exact Event IDs `[01]`–`[32]`).
   - Present a Markdown table with columns: `Event IDs | Actor / Source IP | Observed Activity | Why It Appears Suspicious | Proof It Is Benign or Unsuccessful Noise`.

2. **Section 2: 6-Stage APT Kill-Chain Reconstruction & MITRE ATT&CK Mapping**
   - Reconstruct the exact chronological attack path across all 6 stages (Initial Access/SSRF → Off-Network Token Replay & IAM Impersonation → Kubernetes Ephemeral Container Injection → eBPF `nsenter` Host Namespace Escape & Credential Harvesting → GCS + Cloud KMS Master Key Decryption → Covert DNS `TXT` Exfiltration & Anti-Forensics).
   - Present a Markdown table with columns: `Stage | Event IDs & UTC Timestamps | MITRE ATT&CK Tactic & Sub-Technique ID | Source → Target Pivot | Technical Mechanism & Evidence`.
   - Calculate the **estimated volume of exfiltrated data** based on the `1,420` hex-encoded DNS queries (`[26]`–`[30]`) vs. the `48.29 MB` encrypted shard (`[22]`), and explain why `zlib` compression (`[24]`) or filtering was used after `[25]` (`DENIED_EGRESS_FIREWALL`) blocked direct HTTPS exfiltration.

3. **Section 3: Compromised Identity, Host & Cryptographic Blast-Radius Inventory**
   - Provide a complete inventory table of every compromised GCP Service Account, GKE Pod, GKE Node, KMS Key, and GCS Bucket, detailing how the attacker obtained access and what maximum privileges were exposed.

4. **Section 4: Production Detection Engineering Rules (Chronicle YARA-L 2.0 + Tetragon/Falco eBPF)**
   - **Rule A (Google SecOps / Chronicle YARA-L 2.0)**: Write a complete multi-event YARA-L 2.0 rule correlating an internal GKE IMDS token fetch with a subsequent GCP Cloud Audit call using that same `principalEmail` from a non-RFC1918 / non-Google ASN (`AS205100` or external IP) within a `15m` match window.
   - **Rule B (Tetragon `TracingPolicy` or Falco Rule)**: Write a complete kernel eBPF rule that detects and blocks (`Sigkill`) any container process invoking `sys_setns` or executing `nsenter` targeting PID `1` (`host_pid_ns`).

5. **Section 5: Zero-Downtime Containment & Eradication Runbook (`T+0m` to `T+60m`)**
   - Provide an ordered, copy-pasteable CLI runbook (`gcloud`, `kubectl`, Cloud DNS Response Policy) broken into `T+0m (Immediate Egress & IAM Cut-Off)`, `T+5m (Forensic Memory/Disk Preservation before Cordon)`, `T+15m (Service Account Key/Token Revocation & Workload Identity Hardening)`, and `T+60m (KMS Key Rotation & Architectural Fixes)` — explicitly explaining how you isolate the compromised GKE node and revoke stolen OAuth2 tokens **without** taking down live customer checkout traffic on healthy pods.
