# EmotiX Infrastructure (CDK) — How It Works and Why

This repo provisions EmotiX infrastructure using **AWS CDK (TypeScript)** across **multiple AWS accounts** and **multiple regions**.

The key idea is:

- **DNS is delegated** from the Management account to the Test account (for `test.emotix.net`).
- **TLS certificates must exist before stacks that attach them** (CloudFront, Cognito custom domains, etc.).
- Some services require a certificate in **us-east-1** (“global/edge”), others require a certificate in the **resource region** (here **eu-central-1**).

This document explains the architecture, stack responsibilities, and the **required deployment order**, including where `cdk.json` context values are used.

---

## Accounts and Regions

### Accounts

- **MGMT account** (`MGMT_ACCOUNT_ID`): owns the apex hosted zone (e.g. `emotix.net`) and delegates subzones.
- **TEST account** (`TEST_ACCOUNT_ID`): owns the hosted zone for `test.emotix.net`, and runs most test workloads.
- **PROD account** (`PROD_ACCOUNT_ID`): future production workloads.

### Regions

- **eu-central-1**: primary region for regional services (User Pool, API Gateway (regional), ALB/ECS later, etc.).
- **us-east-1**: required for edge/global services’ certificates (CloudFront, Cognito custom domain certificate).

---

## Domain & DNS Model

- **Apex domain**: `emotix.net` (in MGMT account).
- **Environment subdomain**: `test.emotix.net` (hosted zone in TEST account).
- MGMT account delegates `test.emotix.net` via **NS records**.

Important: delegation requires the **Name Servers from the TEST hosted zone**, which appear only after the TEST DNS stack is deployed once.

---

## TLS Certificate Strategy (Why Two Certificates)

We create **two certificates with the same coverage**:

- `test.emotix.net`
- `*.test.emotix.net`

But we create them in **two regions** because AWS services require different certificate regions:

### 1) Global / Edge certificate — **us-east-1**
Used for:
- **CloudFront** custom domains (CloudFront requires ACM cert in `us-east-1`)
- **Cognito custom domain** (Cognito custom domains require cert in `us-east-1`)

### 2) Regional certificate — **eu-central-1**
Used for:
- **API Gateway** custom domains (regional endpoint)
- **ALB** (when we deploy ECS/Fargate/EKS behind an ALB)
- Any other regional resource that needs TLS termination

ACM public certificates are **free**. Costs are not impacted by having multiple ACM certificates. Costs are driven by the services (CloudFront, API Gateway, ALB, etc.), not ACM itself.

---

## Stacks Overview

Below is the main `cdk.ts` flow and what each stack does.

### 1) `EmotixTestDnsStack` (TEST, eu-central-1)
Creates the hosted zone for:
- `test.emotix.net`

Outputs:
- NS records (needed by MGMT delegation)

### 2) `EmotixManagementDnsStack` (MGMT, eu-central-1)
Creates/updates delegation from `emotix.net` to `test.emotix.net`:
- Adds **NS record** in the MGMT hosted zone pointing to TEST hosted zone name servers
- Also manages email DNS records (MX/SPF/DMARC/DKIM) as needed

⚠️ This stack needs the `testNs` context value (the NS from the TEST hosted zone).

### 3) `EmotixTestGlobalCertStack` (TEST, us-east-1)
Issues ACM cert for:
- `test.emotix.net`
- `*.test.emotix.net`

Used by:
- CloudFront (WebStack)
- Cognito custom domain (AuthStack)

### 4) `EmotixTestRegionalCertStack` (TEST, eu-central-1)
Issues ACM cert for:
- `test.emotix.net`
- `*.test.emotix.net`

Used by:
- API Gateway custom domain (future)
- ALB TLS (future)

### 5) `EmotixTestWebStack` (TEST, eu-central-1)
Deploys the static web hosting:
- S3 bucket for web build artifacts (private)
- CloudFront distribution
- Route53 records for `test.emotix.net`
- Security headers / redirects (as configured in `web-stack.ts`)

⚠️ This stack needs the **global (us-east-1) certificate ARN**.  
You pass it via CDK context: `context.globalTestTlsCertArn`.

### 6) `BillingGuardrailsStack` (MGMT, us-east-1)
Cost controls and guardrails:
- budgets, alerts, anomaly monitor hooks
- optionally attaches SCP to accounts

### 7) `EmotixTestAuthStack` (TEST, eu-central-1)
Cognito User Pool based auth:
- Email + Google + Facebook (Apple after MVP)
- Custom auth domain: `auth.test.emotix.net`
- Redirect URIs set for the web app:
  - callback: `https://test.emotix.net/auth/callback`
  - logout: `https://test.emotix.net/logout`

⚠️ Cognito custom domain certificate must be **us-east-1**, so this stack uses the same **global** cert ARN via context `globalTestTlsCertArn`.

SSM parameters are expected to exist already:
- `/emotix/test/auth/google/client-id`
- `/emotix/test/auth/google/client-secret`
- `/emotix/test/auth/facebook/app-id`
- `/emotix/test/auth/facebook/app-secret`

---

## Required Deployment Order

### Step 0 — AWS SSO / CDK bootstrap
Make sure you deploy using a profile that is authenticated into the **target account** (TEST vs MGMT).  
Also bootstrap both regions for the account you deploy into:

```bash
# Example for TEST account
npx cdk bootstrap aws://<TEST_ACCOUNT_ID>/eu-central-1 --profile emotix-test
npx cdk bootstrap aws://<TEST_ACCOUNT_ID>/us-east-1     --profile emotix-test

# Example for MGMT account
npx cdk bootstrap aws://<MGMT_ACCOUNT_ID>/eu-central-1  --profile emotix-mgmt
npx cdk bootstrap aws://<MGMT_ACCOUNT_ID>/us-east-1     --profile emotix-mgmt
```

---

### Step 1 — Deploy TEST DNS hosted zone
Deploy:

```bash
npx cdk deploy EmotixTestDnsStack --require-approval never --profile emotix-test
```

Then retrieve the hosted zone **Name Servers** from Route53 (AWS Console or CLI).  
Add them into `cdk.json` as `testNs`.

Example `cdk.json`:

```json
{
  "context": {
    "testNs": [
      "ns-123.awsdns-45.org.",
      "ns-678.awsdns-90.co.uk.",
      "ns-111.awsdns-22.com.",
      "ns-333.awsdns-44.net."
    ]
  }
}
```

---

### Step 2 — Deploy MGMT delegation (uses `testNs`)
Deploy:

```bash
npx cdk deploy EmotixManagementDnsStack --require-approval never --profile emotix-mgmt
```

This creates NS delegation so `test.emotix.net` resolves publicly.

---

### Step 3 — Deploy certificate stacks FIRST (then capture ARNs)
Deploy global and regional cert stacks in TEST:

```bash
npx cdk deploy EmotixTestGlobalCertStack   --require-approval never --profile emotix-test
npx cdk deploy EmotixTestRegionalCertStack --require-approval never --profile emotix-test
```

Copy the **CertificateArn** output for the global cert and put it into `cdk.json` context.

Example:

```json
{
  "context": {
    "testNs": ["..."],
    "globalTestTlsCertArn": "arn:aws:acm:us-east-1:836622697490:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

Why do we store the ARN in context?
- It ensures CloudFront/Cognito stacks can import a cert that lives in **us-east-1**
- It avoids cross-stack direct references across regions (which CloudFormation cannot do directly)

---

### Step 4 — Deploy WebStack (uses global cert ARN from context)
```bash
npx cdk deploy EmotixTestWebStack --require-approval never --profile emotix-test
```

---

### Step 5 — Deploy AuthStack (uses global cert ARN from context)
```bash
npx cdk deploy EmotixTestAuthStack --require-approval never --profile emotix-test
```

---

### Step 6 — Deploy Billing Guardrails (MGMT)
```bash
npx cdk deploy BillingGuardrailsStack --require-approval never --profile emotix-mgmt
```

---

## Redirect URIs (Cognito + IdPs)

### Cognito App Client URLs
- Callback URL:
  - `https://test.emotix.net/auth/callback`
- Logout URL:
  - `https://test.emotix.net/logout`

### Google/Facebook Redirect URI (to Cognito)
Ensure your Google and Meta apps include:

- `https://auth.test.emotix.net/oauth2/idpresponse`

This is where Google/Facebook redirect *back to Cognito*.

---

## Context Values Used in `cdk.ts`

Your `cdk.ts` expects:

- `context.testNs`  
  Used by: `EmotixManagementDnsStack`  
  Why: delegation from MGMT to TEST needs the hosted zone NS values.

- `context.globalTestTlsCertArn`  
  Used by: `EmotixTestWebStack` and `EmotixTestAuthStack`  
  Why: CloudFront and Cognito custom domain require cert in `us-east-1`.

---

## Common Troubleshooting

### “Could not assume role … cdk-hnb659fds-deploy-role …”
You are logged into the wrong account/profile or the target region is not bootstrapped.

Fix:
- login to the correct SSO profile for the target account
- bootstrap the target account/region

### Cognito custom domain fails with “Invalid request provided: AWS::Cognito::UserPoolDomain”
Most often caused by wrong certificate region. For Cognito custom domain:
- cert must be in **us-east-1**

### SecureString SSM for Cognito IdP client_secret
CloudFormation does not support `ssm-secure` dynamic references for Cognito IdP client secrets.
For now we store Google/Facebook secrets as **SSM String** (still IAM-protected).

---

## Appendix: Current `cdk.ts` ordering (simplified)

The repo currently follows this ordering:

1. TestDnsStack (TEST)
2. ManagementDnsStack (MGMT, requires `testNs`)
3. GlobalCertStack (TEST us-east-1)
4. RegionalCertStack (TEST eu-central-1)
5. WebStack (TEST, requires `globalTestTlsCertArn`)
6. BillingGuardrails (MGMT)
7. AuthStack (TEST, requires `globalTestTlsCertArn`)
