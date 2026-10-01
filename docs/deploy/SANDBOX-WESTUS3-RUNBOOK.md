# Runbook: TokenScope sandbox on Azure (West US 3) via GitHub Actions

Fork-specific runbook for deploying this fork to:

|                    |                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Subscription       | Visual Studio Enterprise Subscription (GitHub secret `AZURE_SUBSCRIPTION_ID`)                |
| Resource group     | `rg-tokenscope-sandbox-wus3` (West US 3, dedicated to this deployment)                       |
| Posture            | Sandbox: public endpoints, no VNet, no Front Door ([DEPLOY-AZURE.md §3](../DEPLOY-AZURE.md)) |
| Parameter file     | `infra/parameters/sandbox.bicepparam`                                                        |
| Workflows          | `.github/workflows/tokenscope-infra.yml`, `.github/workflows/tokenscope-deploy.yml`          |
| GitHub environment | `sandbox`                                                                                    |

It follows [DEPLOY-AZURE.md](../DEPLOY-AZURE.md) and
[examples/github-actions/README.md](../../examples/github-actions/README.md);
read those for the why. This page is the exact what, for this target.

## 0. What this deploys

One Azure Container App (the Nuxt app, port 3000, `/api/health` probes) on a
workload-profiles Container Apps environment (Consumption profile), plus:

| Resource                                                | Name                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| User-assigned managed identity                          | `id-tssunil-sandbox-wus3`                                    |
| Container Apps environment / app                        | `cae-tssunil-sandbox-wus3` / `ca-tssunil-sandbox-wus3`       |
| Container Registry (Basic)                              | `crtssunilsandboxwus3`                                       |
| Key Vault (RBAC)                                        | `kv-tssunil-sandbox-wus3`                                    |
| PostgreSQL Flexible Server (B2s) + db `tokenscope`      | `pg-tssunil-sandbox-wus3`                                    |
| Azure Cache for Redis (Basic)                           | `redis-tssunil-sandbox-wus3`                                 |
| Log Analytics / Application Insights                    | `log-tssunil-sandbox-wus3` / `appi-tssunil-sandbox-wus3`     |
| OTLP ingest: Data Collection Endpoint + Rule            | `dce-tssunil-sandbox-wus3` / `dcr-tssunil-sandbox-wus3-otlp` |
| Metric + log alerts, scheduled worker jobs (`caj-ts-*`) | created on the second apply                                  |

`what-if` against the resource group (2026-10-01): **28 to create, 0 to
modify, 0 to delete.**

> **History.** The first target was `rg-westus3-t1-services-sandbox-Rakesh-001`
> in `Sub_IT_Global_Sandbox_001`, a resource group shared with ~35 unrelated
> resources. It was abandoned because the subscription lacked the
> `Microsoft.OperationalInsights`, `Microsoft.DBforPostgreSQL` and
> `Microsoft.Cache` providers and the deployer could not register them. The
> workflows' explicit registry / app / deployment names (below) date from
> then and stay: they cost nothing and protect any shared group.

### Why the CI identity is Contributor, not Owner

Upstream's guide gives the deployment identity Owner, because the template
creates five role assignments for the app's managed identity (AcrPull, Key
Vault Secrets User, Monitoring Metrics Publisher, Monitoring Reader, Log
Analytics Reader). In this tenant every Owner assignment carries an **ABAC
condition** that forbids granting the privileged roles Owner, User Access
Administrator and Role Based Access Control Administrator. No identity this
operator controls can therefore be given the right to write role assignments,
and that guardrail is not to be worked around (for example with a custom role
holding `roleAssignments/write`). So:

- The CI identity gets **Contributor** on the resource group, and its applies
  run with `TOKENSCOPE_DEPLOY_RBAC = false`.
- The five managed-identity assignments are created **once**, by an operator
  apply with `deployRbac` true (§5 step 2): the operator's own Owner role may
  grant them, because none is a privileged role. Incremental applies never
  delete them.

## 1. Prerequisites and blockers

| #   | Item                                                                                                                         | Who                                                      | Status                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Register resource providers `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.DBforPostgreSQL`, `Microsoft.Cache` | Subscription Owner (you)                                 | Done 2026-10-01.                                                                                                                                                                                         |
| B2  | Admin consent for Microsoft Graph `User.Read.All` (Application) on the sign-in app registration                              | Entra Global / Privileged Role / Cloud Application Admin | **Blocker for full function.** Sign-in, enrolment, telemetry work without it; people picker and manager lookups fail. If the tenant restricts user consent, sign-in itself stops at "Approval required". |
| P1  | Contributor on the resource group for the deploying identity (Owner is not grantable here, see §0)                           | RG Owner (you)                                           | §3.2.                                                                                                                                                                                                    |
| P2  | Two Entra app registrations (sign-in; GitHub deployment identity)                                                            | You (tenant allows users to create apps)                 | To do (§3).                                                                                                                                                                                              |
| P3  | GitHub environment `sandbox` with secrets and variables                                                                      | Fork admin (you)                                         | To do (§4).                                                                                                                                                                                              |
| P4  | Workflows on the fork's default branch                                                                                       | You                                                      | Merge this PR. `workflow_dispatch` only lists workflows on the default branch.                                                                                                                           |
| —   | `Microsoft.Monitor` (not registered)                                                                                         | —                                                        | Avoided: `deployAzureMonitorWorkspace = false`.                                                                                                                                                          |
| —   | `Microsoft.Cdn` (not registered)                                                                                             | —                                                        | Not needed: no Front Door.                                                                                                                                                                               |
| —   | Global name availability (KV, ACR, Postgres, Redis)                                                                          | —                                                        | Checked free 2026-10-01; no soft-deleted vault with that name.                                                                                                                                           |

Providers (B1):

```bash
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.DBforPostgreSQL Microsoft.Cache; do
  az provider register --subscription "$SUB" --namespace "$ns"
done
```

Tools on the operator machine: Azure CLI 2.60+ with Bicep, `openssl`, `git`,
and (optional, for setting secrets) GitHub CLI `gh`.

**Windows / Git Bash:** Git Bash rewrites arguments that start with `/`
(`--scope /subscriptions/...` becomes `C:/Program Files/Git/subscriptions/...`).
Run `az` commands with such arguments from PowerShell, or prefix them with
`MSYS_NO_PATHCONV=1`.

## 2. Azure setup

Nothing to create by hand beyond the identities in §3: the template creates
every resource. Confirm the context:

```bash
SUB=<subscription id>
az account set --subscription "$SUB"
RG=rg-tokenscope-sandbox-wus3
az group create -n "$RG" -l westus3 --tags project=tokenscope env=sandbox
```

## 3. Entra ID app registrations

### 3.1 Sign-in registration (the app's users)

Per [DEPLOY-AZURE.md §1, Entra ID app registration](../DEPLOY-AZURE.md#entra-id-app-registration):

```bash
SIGNIN_APP=$(az ad app create --display-name tokenscope-sandbox-wus3-signin \
  --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad sp create --id "$SIGNIN_APP"
# Graph: delegated openid/profile/email/offline_access/User.Read, application User.Read.All
GRAPH=00000003-0000-0000-c000-000000000000
az ad app permission add --id "$SIGNIN_APP" --api $GRAPH --api-permissions \
  37f7f235-527c-4136-accd-4a02d197296e=Scope \
  14dad69e-099b-42c9-810b-d002981feec1=Scope \
  64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0=Scope \
  7427e0e9-2fba-42fe-b0c0-848c9e6a8182=Scope \
  e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope \
  df021288-bdef-4463-88db-98f22de89214=Role
# Optional claim `email` on the ID token
az ad app update --id "$SIGNIN_APP" --optional-claims '{"idToken":[{"name":"email","essential":false}]}'
# Client secret -> ENTRA_CLIENT_SECRET (shown once)
az ad app credential reset --id "$SIGNIN_APP" --display-name gha-sandbox --years 1 --query password -o tsv
```

Then ask an Entra admin (B2) to **Grant admin consent** on it. Redirect URIs
are added in §5 step 4, once the app's host is known.

### 3.2 Deployment identity (GitHub Actions OIDC, no stored Azure secret)

```bash
DEPLOY_APP=$(az ad app create --display-name tokenscope-sandbox-wus3-gha \
  --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad sp create --id "$DEPLOY_APP"
az ad app federated-credential create --id "$DEPLOY_APP" --parameters '{
  "name": "gha-sunilokbits-tokenscope-public-sandbox",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:sunilokbits/tokenscope-public:environment:sandbox",
  "audiences": ["api://AzureADTokenExchange"]
}'
az role assignment create --assignee "$DEPLOY_APP" --role Contributor \
  --scope "$(az group show -n "$RG" --query id -o tsv)"
```

Contributor, scoped to this one resource group: enough for every apply with
`TOKENSCOPE_DEPLOY_RBAC = false`, for `az acr build`, `az acr import` and
`az containerapp update`. Not Owner (§0), and never subscription scope.

## 4. GitHub configuration

**Settings → Environments → New environment → `sandbox`.**

- Deployment branches and tags: **Selected branches → `main`**.
- Required reviewers: yourself (approve each apply/deploy).

### Secrets (environment `sandbox`)

| Secret                                                     | Required | Value                                                                                      |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `AZURE_CLIENT_ID`                                          | yes      | `$DEPLOY_APP` (§3.2)                                                                       |
| `AZURE_TENANT_ID`                                          | yes      | `az account show --query tenantId -o tsv`                                                  |
| `AZURE_SUBSCRIPTION_ID`                                    | yes      | `az account show --query id -o tsv`                                                        |
| `PG_ADMIN_LOGIN`                                           | yes      | `tsadmin`                                                                                  |
| `PG_ADMIN_PASSWORD`                                        | yes      | generated, below                                                                           |
| `SESSION_SECRET`                                           | yes      | generated (≥ 32 chars)                                                                     |
| `HMAC_SESSION_KEY`                                         | yes      | generated (≥ 32 chars)                                                                     |
| `INTERNAL_WORKER_HMAC_KEY`                                 | yes      | generated (≥ 32 chars)                                                                     |
| `OIDC_SESSION_SECRET`                                      | yes      | generated                                                                                  |
| `OIDC_AUTH_SESSION_SECRET`                                 | yes      | generated                                                                                  |
| `OIDC_TOKEN_KEY`                                           | yes      | generated, base64 of 32 bytes                                                              |
| `ENTRA_CLIENT_SECRET`                                      | yes      | §3.1 client secret                                                                         |
| `ANTHROPIC_API_KEY`, `GH_PAT_*`, `GH_APP_KEY_PARTNER_DEMO` | no       | provider credentials ([DEPLOY-AZURE.md](../DEPLOY-AZURE.md#optional-provider-credentials)) |

Generate once and keep the file (gitignored by `*secrets.env`); changing these
later signs everyone out or rotates the database login:

```bash
SECRETS=.azure-sandbox-secrets.env
cat > "$SECRETS" <<EOF
PG_ADMIN_LOGIN='tsadmin'
PG_ADMIN_PASSWORD='$(openssl rand -base64 24)Aa1!'
SESSION_SECRET='$(openssl rand -base64 48)'
HMAC_SESSION_KEY='$(openssl rand -base64 48)'
INTERNAL_WORKER_HMAC_KEY='$(openssl rand -base64 48)'
OIDC_SESSION_SECRET='$(openssl rand -base64 36)'
OIDC_AUTH_SESSION_SECRET='$(openssl rand -base64 36)'
OIDC_TOKEN_KEY='$(openssl rand -base64 32)'
ENTRA_CLIENT_SECRET='<from §3.1>'
EOF
chmod 600 "$SECRETS"

set -a; . "./$SECRETS"; set +a
for name in PG_ADMIN_LOGIN PG_ADMIN_PASSWORD SESSION_SECRET HMAC_SESSION_KEY \
            INTERNAL_WORKER_HMAC_KEY OIDC_SESSION_SECRET OIDC_AUTH_SESSION_SECRET \
            OIDC_TOKEN_KEY ENTRA_CLIENT_SECRET; do
  gh secret set "$name" --repo sunilokbits/tokenscope-public --env sandbox --body "${!name}"
done
```

Without `gh`, paste each value in the GitHub UI.

### Variables (environment `sandbox`)

| Variable                     | Required           | Value                                     | Read by                                                          |
| ---------------------------- | ------------------ | ----------------------------------------- | ---------------------------------------------------------------- |
| `AZURE_RESOURCE_GROUP`       | yes                | `rg-tokenscope-sandbox-wus3`              | both                                                             |
| `TOKENSCOPE_DEPLOY_RBAC`     | yes here           | `false` (CI identity is Contributor, §0)  | infra → `deployRbac`                                             |
| `TOKENSCOPE_PARAMS`          | yes                | `infra/parameters/sandbox.bicepparam`     | infra                                                            |
| `TOKENSCOPE_DEPLOYMENT_NAME` | yes here           | `tokenscope-sandbox`                      | infra                                                            |
| `TOKENSCOPE_ACR_NAME`        | yes here           | `crtssunilsandboxwus3`                    | deploy                                                           |
| `TOKENSCOPE_APP_NAME`        | yes here           | `ca-tssunil-sandbox-wus3`                 | deploy                                                           |
| `ENTRA_TENANT_ID`            | yes                | tenant id                                 | infra → `entraIdTenantId`                                        |
| `ENTRA_CLIENT_ID`            | yes                | `$SIGNIN_APP` (§3.1)                      | infra → `entraIdClientId`                                        |
| `BOOTSTRAP_ADMIN_EMAIL`      | yes                | your Entra email (becomes platform-admin) | infra → `bootstrapAdminEmail`                                    |
| `TOKENSCOPE_PUBLIC_ORIGIN`   | after first deploy | `https://<containerAppUrl>`               | infra → `appPublicOrigin`, `entraIdRedirectUri`, `workerBaseUrl` |
| `ALERT_NOTIFICATION_EMAIL`   | no                 | ops email for alerts                      | infra                                                            |
| `TOKENSCOPE_HEALTH_URL`      | no                 | alternative health-check base URL         | deploy                                                           |

"Yes here" = required for this fork's workflows: they name the registry, app
and deployment explicitly rather than taking the first one in the group, and
skip role assignments the CI identity may not write.

## 5. Deployment sequence

Run from **Actions** on `main`, environment `sandbox`.

1. **TokenScope infra**, mode `what-if`. Expect 23 creates (28 minus the five
   role assignments it skips) and no modify or delete.
2. **First apply, by the operator** (once; creates the five managed-identity
   role assignments the CI identity may not, §0). From the repo root, with the
   same secrets file that filled the GitHub secrets:

   ```bash
   set -a; . ./.azure-sandbox-secrets.env; set +a
   export ENTRA_TENANT_ID=<tenant id> ENTRA_CLIENT_ID=<sign-in app id> \
          BOOTSTRAP_ADMIN_EMAIL=<your email> TOKENSCOPE_DEPLOY_RBAC=true
   az deployment group create -g "$RG" --name tokenscope-sandbox \
     --template-file infra/main.bicep --parameters infra/parameters/sandbox.bicepparam --no-wait
   bash infra/scripts/approve-front-door-private-link.sh "$RG" tokenscope-sandbox   # exit 3 = expected
   ```

   Creates everything; the Container App fails with `MANIFEST_UNKNOWN` (no
   image yet), which the script reports as exit 3. Takes ~15–25 min.

3. **TokenScope deploy**, build `acr-task`. Builds in ACR under the commit
   tag, rolls the app, verifies the revision is healthy and serving the
   commit, then moves `latest`.
4. Get the host and wire sign-in:

   ```bash
   az deployment group show -g "$RG" -n tokenscope-sandbox \
     --query properties.outputs.containerAppUrl.value -o tsv \
     || az containerapp show -g "$RG" -n ca-tssunil-sandbox-wus3 \
          --query properties.configuration.ingress.fqdn -o tsv
   HOST=<that fqdn>
   az ad app update --id "$SIGNIN_APP" \
     --web-redirect-uris "https://$HOST/auth/entra/callback" "https://$HOST/login"
   ```

   Set the variable `TOKENSCOPE_PUBLIC_ORIGIN = https://$HOST`.

5. **TokenScope infra**, mode `apply` again. Pins the public origin, sets the
   redirect URI and creates the worker jobs and alerts.
6. Every later release: **TokenScope deploy** only. Re-run **infra** only when
   the parameter file, the templates or the environment variables change.

## 6. Validation

| Check              | Command / action                                                                                                                       | Expect                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Health             | `curl -s -o /dev/null -w '%{http_code}' https://$HOST/api/health`                                                                      | `200`                                    |
| Build              | `curl -s https://$HOST/api/v1/meta/build`                                                                                              | `commit` = the deployed SHA              |
| Revision           | `az containerapp revision list -g "$RG" -n ca-tssunil-sandbox-wus3 -o table`                                                           | latest revision Healthy, 100% traffic    |
| Sign-in            | Open `https://$HOST/login`, sign in with `BOOTSTRAP_ADMIN_EMAIL`                                                                       | lands as platform-admin                  |
| Workers            | `az containerapp job list -g "$RG" --query "[?starts_with(name,'caj-ts')].name" -o tsv`                                                | jobs present after step 5                |
| Join runs          | `az containerapp job execution list -g "$RG" -n caj-ts-azure-monitor-read -o table`                                                    | executions every 5 min, Succeeded        |
| Telemetry          | [DEPLOY-AZURE.md, Check that telemetry arrives](../DEPLOY-AZURE.md#check-that-telemetry-arrives)                                       | `OTelLogs` rows after a developer enrols |
| App identity roles | `az role assignment list --all --assignee $(az identity show -g "$RG" -n id-tssunil-sandbox-wus3 --query principalId -o tsv) -o table` | 5 assignments (§0)                       |

## 7. Rollback

- **Bad release (app):** the deploy workflow rolls back automatically when the
  roll or verification fails, and never moves `latest`. By hand:

  ```bash
  az containerapp revision list -g "$RG" -n ca-tssunil-sandbox-wus3 -o table
  az containerapp update -g "$RG" -n ca-tssunil-sandbox-wus3 \
    --image crtssunilsandboxwus3.azurecr.io/tokenscope:<previous-12-char-sha>
  ```

  Database migrations run on boot and are forward-only: an image older than
  the schema may fail. Restore Postgres to a point in time (below) if a
  release's migration must be undone.

- **Bad infrastructure change:** revert the commit on `main` and run
  **TokenScope infra** `apply`. Deployments are incremental; removed resources
  are not deleted automatically.
- **Database:** Flexible Server point-in-time restore (7-day backups):
  `az postgres flexible-server restore -g "$RG" --name pg-tssunil-sandbox-wus3-restore --source-server pg-tssunil-sandbox-wus3 --restore-time <UTC ISO time>`,
  then point `database-url` in Key Vault at it.
- **Full teardown:** the resource group holds only this deployment, so
  review it and delete the group:

  ```bash
  az resource list -g "$RG" -o table
  az group delete -n "$RG"
  ```

  The Key Vault stays soft-deleted for 90 days: redeploy with
  `keyVaultCreateMode = 'recover'`, or purge it
  (`az keyvault purge -n kv-tssunil-sandbox-wus3`). Remove the role
  assignment and the two app registrations if retiring the environment.

## 8. Keeping the fork in sync with upstream

Remotes: `origin` = `sunilokbits/tokenscope-public` (this fork), `upstream` =
`Insight-Services-APAC/tokenscope-public`.

This fork only **adds** files (`.github/workflows/tokenscope-*.yml`,
`infra/parameters/sandbox.bicepparam`, this runbook), so upstream merges do
not conflict with it. Track upstream **releases**, not every `main` commit
(DEPLOY-AZURE.md: deploy a release):

```bash
git fetch upstream --tags
git switch main && git pull --ff-only origin main
git switch -c sync/upstream-<version>
git merge --no-ff v<version>           # or upstream/main
# Port upstream changes to the workflows you copied:
git diff <previous-version> v<version> -- examples/github-actions/ infra/parameters/example-sandbox.bicepparam
git push -u origin sync/upstream-<version>   # open a PR into main, CI runs
```

Read the release notes for "before upgrading" steps, merge the PR, then run
**infra** `what-if` → `apply` if templates changed, and **deploy**. Never
force-push `main`, and do not use GitHub's "Discard commits" sync button,
which drops the fork's own files.
