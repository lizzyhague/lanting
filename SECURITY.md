# Security policy

English | [中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

Please use the GitHub repository's private **Report a vulnerability** entry first. Do not paste exploit
details, access tokens, host names, project paths, logs or conversation content into a public issue.

If private reporting is not enabled yet, open an issue without technical details asking the maintainer for
a private contact. The maintainer will do their best to acknowledge reports, but the project currently
promises no fixed response time.

## Security model

lanting is a single-user, self-hosted tool. It provides no multi-user accounts, MFA, per-user
authorization, token expiry or audit system. Whoever can sign in can direct every configured AI CLI on the
host, so the impact of a leaked token depends on:

- the permissions of the system account running lanting;
- the configured project root;
- the permission mode chosen for each AI in each group, and each CLI's own permission configuration;
- whether the network entry point adds further restrictions such as a private network, an identity proxy
  or a firewall.

Several AIs run in the same group with the same system account. Text that one AI writes into the group,
and the contents of files and attachments, reach the other AIs as conversation, not as instructions from
you. Treat it as untrusted input, and approve tool calls with that in mind.

The service always listens on `127.0.0.1`. Remote access must go through a controlled HTTPS entry point,
not by changing the source or mapping the port to the public internet.

lanting does not override the CLIs' permission defaults: when no permission mode is chosen, each CLI uses
its own. A deployer who raises permissions also takes on the larger risk of a leaked token.

lanting removes `ACCESS_TOKEN` from the environment it passes to the CLIs. For Claude Code it also denies
tool calls that contain the configured tokens, dump the environment, or name common secret files. These
are safeguards, not a sandbox: an AI with broad permissions can still read whatever the service account can read.

## Secrets

Do not commit the following to the repository or attach them to public reports:

- `ACCESS_TOKEN` and the rest of the service environment;
- the CLIs' sign-in credentials and configuration;
- `config.json` and `DATA_DIR`;
- reverse proxy private keys;
- logs and screenshots containing project names, conversation content, absolute paths or environment
  variables.

Attachments are stored by the separate ai-remote-upload service. Only the service account should be able
to access its storage and Unix socket, and the socket must not be forwarded to the network. The browser is
shown only original attachment names, never server paths; the paths go only to the AIs called in that
round.

If you suspect the token has leaked, generate a new one at once, update the service environment and
restart the service; every sign-in cookie issued under the old token becomes invalid with it. Removing a
secret from Git does not replace rotating a credential that has already leaked.
