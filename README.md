# EmotiX Infrastructure

This repository contains the Infrastructure as Code (IaC) for EmotiX, built with **AWS CDK (TypeScript)**.

The goal of this setup is:

* clean multi-account AWS architecture
* production-grade security from day one
* easy scaling from solo founder → 100–200 engineers
* minimal differences between test and prod environments

---

## High-level architecture

```
Domain registrar
   ↓ NS
AWS Route53 (Management account)
   ├─ emotix.net (public hosted zone)
   ├─ NS delegation → test.emotix.net
   └─ NS delegation → emotix.net (prod)

AWS Test account
   ├─ Route53: test.emotix.net
   ├─ ACM (us-east-1): TLS cert for CloudFront
   ├─ CloudFront
   ├─ S3 (private, OAC)
   └─ Application resources (later)

AWS Prod account
   └─ same structure as Test, with stricter policies
```

---

## Repository structure

```
cdk/
├─ bin/
│  └─ cdk.ts                # CDK app entrypoint
├─ lib/
│  ├─ management-dns-stack.ts
│  ├─ test-dns-stack.ts
│  ├─ cert-stack.ts
│  └─ web-stack.ts
├─ cdk.json                 # CDK context + feature flags
├─ package.json
└─ tsconfig.json
```

---

## AWS account structure

We use **AWS Organizations** with a strict separation of responsibilities.

### Accounts

| Account    | Purpose                                                |
| ---------- | ------------------------------------------------------ |
| Management | Organizations, IAM Identity Center, Route53 root zones |
| Test       | test.emotix.net, test infrastructure                   |
| Prod       | emotix.net, production infrastructure                  |

Only the **Management account**:

* owns the root domain `emotix.net`
* manages IAM Identity Center
* assigns permissions to users

---

## Identity & access model

* IAM Identity Center (SSO)
* No IAM users
* No long-lived access keys

### Permission sets

| Permission set         | Usage                  |
| ---------------------- | ---------------------- |
| AWSAdministratorAccess | Bootstrap & infra work |
| ReadOnly               | Auditing               |
| Custom (future)        | Developers / CI        |

### Recommended CLI profiles

```
emotix-mgmt-admin
emotix-test-admin
emotix-prod-admin
```

Always verify before deploy:

```bash
aws sts get-caller-identity
```

---

## DNS architecture

### Root domain

* `emotix.net` hosted zone lives **only in Management account**
* Registrar NS → Route53 (management)

### Delegation

| Subdomain       | Account |
| --------------- | ------- |
| test.emotix.net | Test    |
| emotix.net      | Prod    |

Delegation is done using NS records from management → child hosted zones.

---

## CDK bootstrap strategy

Each account + region must be bootstrapped.

### Required bootstraps

```bash
cdk bootstrap aws://MGMT_ID/eu-central-1
cdk bootstrap aws://TEST_ID/eu-central-1
cdk bootstrap aws://TEST_ID/us-east-1
cdk bootstrap aws://PROD_ID/eu-central-1
cdk bootstrap aws://PROD_ID/us-east-1
```

Why `us-east-1`?

* CloudFront requires ACM certificates in us-east-1.

---

## Stacks overview

### ManagementDnsStack

* Account: Management
* Purpose: delegate `test.emotix.net` and `prod.emotix.net`

### TestDnsStack

* Account: Test
* Purpose: hosted zone `test.emotix.net`

### CertStack

* Account: Test / Prod
* Region: us-east-1
* Purpose: ACM certificate for CloudFront
* Validation: DNS via Route53

### WebStack

* Account: Test / Prod
* Region: eu-central-1
* Components:

  * Private S3 bucket
  * CloudFront distribution
  * Origin Access Control (OAC)
  * Security headers
  * Optional logging
  * Optional WAF

---

## WebStack defaults (test-friendly)

| Feature            | Test default | Prod override |
| ------------------ | ------------ | ------------- |
| S3 retention       | DESTROY      | RETAIN        |
| autoDeleteObjects  | true         | false         |
| CloudFront logging | off          | on            |
| WAF                | off          | on            |

---

## Security headers

CloudFront adds:

* Strict-Transport-Security
* X-Content-Type-Options
* X-Frame-Options
* Referrer-Policy
* X-XSS-Protection

Content-Security-Policy can be added later in Report-Only mode.

---

## Why no S3 static website hosting

We intentionally **do NOT enable S3 static website hosting**:

* bucket stays private
* OAC requires REST endpoint, not website endpoint
* HTTPS, redirects and errors handled by CloudFront

This is the recommended AWS best practice.

---

## Deployment flow

```bash
aws sso login --profile emotix-test-admin
npx cdk deploy EmotixTestCertStack
npx cdk deploy EmotixTestWebStack
```

---

## Next steps

* AuthStack (Cognito: email + Google/Apple/Facebook)
* CI/CD (GitHub Actions → CDK deploy)
* Observability (CloudWatch, alarms)
* WAF rules (prod)

---

## Principles

* identical test & prod architecture
* secure by default
* no manual AWS console changes
* everything reproducible via CDK

---

**EmotiX infrastructure is designed to scale safely and predictably.**
