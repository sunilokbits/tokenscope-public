// ── TokenScope — Sandbox, West US 3 ─────────────────────────────────────────
//
// Derived from example-sandbox.bicepparam. Public endpoints, no VNet, no Front
// Door. Applied by .github/workflows/tokenscope-infra.yml into the GitHub
// environment's AZURE_RESOURCE_GROUP. Runbook:
// docs/deploy/SANDBOX-WESTUS3-RUNBOOK.md.
//
// This file is committed to a public fork, so it holds nothing
// environment-specific: secrets AND identifiers (tenant, client id, admin
// email, public host) are read from the GitHub environment at apply time.

using '../main.bicep'

param env = 'sandbox'
param location = 'westus3'
// Globally unique stem for Key Vault / ACR / Postgres / Redis names.
// Resulting names: kv-tssunil-sandbox-wus3, crtssunilsandboxwus3,
// pg-tssunil-sandbox-wus3, ca-tssunil-sandbox-wus3.
param projectName = 'tssunil'
param imageTag = 'latest'

// Grants the app's managed identity AcrPull, Key Vault Secrets User and the
// monitoring roles, which needs a deploying identity that may write role
// assignments. The tenant's ABAC condition forbids granting Owner / User
// Access Administrator / RBAC Administrator, so the CI identity is
// Contributor only and runs with TOKENSCOPE_DEPLOY_RBAC=false; the five
// assignments are created once by an operator apply with it true (runbook §5).
// Incremental applies never delete them.
param deployRbac = toLower(readEnvironmentVariable('TOKENSCOPE_DEPLOY_RBAC', 'true')) != 'false'

// ── Secrets: read from the environment, never written here ───────────────
param pgAdminLogin = readEnvironmentVariable('PG_ADMIN_LOGIN')
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param sessionSecret = readEnvironmentVariable('SESSION_SECRET')
param hmacSessionKey = readEnvironmentVariable('HMAC_SESSION_KEY')
param internalWorkerHmacKey = readEnvironmentVariable('INTERNAL_WORKER_HMAC_KEY')
param oidcSessionSecret = readEnvironmentVariable('OIDC_SESSION_SECRET')
param oidcAuthSessionSecret = readEnvironmentVariable('OIDC_AUTH_SESSION_SECRET')
param oidcTokenKey = readEnvironmentVariable('OIDC_TOKEN_KEY')
param entraIdClientSecret = readEnvironmentVariable('ENTRA_CLIENT_SECRET')
// Optional provider credentials: empty = not configured.
param anthropicApiKey = readEnvironmentVariable('ANTHROPIC_API_KEY', '')
param githubPatPartnerDemo = readEnvironmentVariable('GH_PAT_PARTNER_DEMO', '')
param githubPatProduction = readEnvironmentVariable('GH_PAT_PRODUCTION', '')
param githubPatApacNfr = readEnvironmentVariable('GH_PAT_ENTERPRISE_NFR', '')
param githubAppKeyPartnerDemo = readEnvironmentVariable('GH_APP_KEY_PARTNER_DEMO', '')

// ── Auth (Entra ID OIDC) ─────────────────────────────────────────────────
param entraIdTenantId = readEnvironmentVariable('ENTRA_TENANT_ID', '')
param entraIdClientId = readEnvironmentVariable('ENTRA_CLIENT_ID', '')

// First Entra sign-in with this email is created as platform-admin.
param bootstrapAdminEmail = readEnvironmentVariable('BOOTSTRAP_ADMIN_EMAIL', '')

// ── Public host ──────────────────────────────────────────────────────────
// Empty on the first apply (the Container App FQDN is not known yet). After
// the first deploy set TOKENSCOPE_PUBLIC_ORIGIN = https://<containerAppUrl>
// and apply again: that pins the origin for device enrolment, sets the Entra
// callback and creates the scheduled worker jobs (runbook step 6).
var publicOrigin = readEnvironmentVariable('TOKENSCOPE_PUBLIC_ORIGIN', '')
param appPublicOrigin = publicOrigin
param entraIdRedirectUri = empty(publicOrigin) ? '' : '${publicOrigin}/auth/entra/callback'
param workerBaseUrl = publicOrigin

// A deployed sandbox has no demo personas (only the local seed creates them).
param allowPersonaOverride = false

// ── Networking / Front Door ──────────────────────────────────────────────
param enablePrivateNetworking = false
param enableFrontDoor = false

// ── Optional ─────────────────────────────────────────────────────────────
// Microsoft.Monitor is not registered on this subscription, and nothing reads
// the Azure Monitor Workspace today.
param deployAzureMonitorWorkspace = false
param alertNotificationEmail = readEnvironmentVariable('ALERT_NOTIFICATION_EMAIL', '')

param keyVaultCreateMode = 'default'    // 'recover' to redeploy within KV soft-delete
