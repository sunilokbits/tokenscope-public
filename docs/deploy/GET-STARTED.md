# Get started with TokenScope (sandbox)

TokenScope shows your AI-assistant token usage. Connect your tool once and keep
working as normal; your usage appears in TokenScope within about 10 minutes.

**TokenScope:** <https://ca-tscope-sandbox-wus3.wittydune-91621c23.westus3.azurecontainerapps.io>
(sign in with your Insight account)

## Claude Code

In Claude Code, run these one at a time:

```
/plugin marketplace add sunilokbits/tokenscope-public
```

```
/plugin install tokenscope@tokenscope
```

When asked, choose **Install for you (user scope)**. Then:

```
/tokenscope:setup
```

Sign in with your Insight account when the browser opens. Done.

## GitHub Copilot CLI

In a terminal, one at a time:

```bash
copilot plugin marketplace add sunilokbits/tokenscope-public
```

```bash
copilot plugin install tokenscope-copilot@tokenscope
```

Start `copilot`, run the **tokenscope-setup** skill, then restart `copilot`.
Check it with the **status** skill.

## See your usage

Open TokenScope → **My usage**.

Nothing there after 15 minutes? Run `/tokenscope:setup` again (Claude Code) or
the **status** skill (Copilot) and send the output to the TokenScope admin.

---

For admins: how the plugin is pointed at this deployment is in
[plugin/README.md](../../plugin/README.md#point-the-plugins-at-your-deployment);
deployment details in [SANDBOX-WESTUS3-RUNBOOK.md](SANDBOX-WESTUS3-RUNBOOK.md).
