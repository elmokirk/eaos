# Security

Report a vulnerability privately through GitHub: **Security → Report a vulnerability** at
<https://github.com/elmokirk/eaos/security/advisories/new>. Please do not open a public issue.

eaos is maintained by one person. Reports are read and taken seriously, but there is no
guaranteed response time and no bug bounty. Only the latest release is supported.

In scope: a secret that reaches a trace unredacted, an edit to a trace that `eaos verify` does
not detect, a write outside `$EAOS_HOME` (other than `eaos setup claude` writing the settings
file it names), and anything that lets the hook or the extension break the agent it records.

Known limits, not vulnerabilities: the chain is tamper-evident, not tamper-proof, against whoever
can write the file (use anchors); `EAOS_ACTOR` is not authenticated. See the README's Limits.
