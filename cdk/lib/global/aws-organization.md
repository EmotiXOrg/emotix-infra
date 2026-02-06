# AWS Organization & Account Strategy (EmotiX)

This document describes **how AWS accounts are structured, why this structure was chosen, and how access is managed**.

It is intentionally **non-technical** (no CDK code) and serves as:

* onboarding material for new team members
* a reference for security & access decisions
* long‑term documentation of architectural intent

---

## Goals of the account strategy

The AWS account model for EmotiX is designed to:

* scale from **1 founder → 100–200 engineers**
* isolate risk between environments
* enforce least‑privilege access
* make production changes intentional and auditable
* avoid "shared account chaos"

**Key principle:**

> *Blast radius must always be limited.*

---

## High‑level structure

```
AWS Organization (root)
│
├─ Management Account
│   ├─ IAM Identity Center (SSO)
│   ├─ AWS Organizations
│   └─ Root DNS (Route53)
│
├─ Test Account
│   ├─ test.emotix.net
│   ├─ test infrastructure
│   └─ experimentation / staging
│
└─ Prod Account
    ├─ emotix.net
    ├─ production infrastructure
    └─ customer‑facing systems
```

---

## Management Account

### Purpose

The Management account is **not** used to run applications.

It exists solely to:

* own the AWS Organization
* manage identities and permissions
* manage root DNS zones

### What lives here

* IAM Identity Center (SSO)
* AWS Organizations
* Route53 hosted zone for `emotix.net`
* Cross‑account delegation records

### What must NEVER live here

* application workloads
* databases
* compute (EC2, ECS, Lambda)
* customer data

> If the Management account is compromised, production must remain isolated.

---

## Environment Accounts (Test / Prod)

### Purpose

Each environment has its **own isolated AWS account**.

This ensures:

* no accidental cross‑environment access
* different security & retention policies
* clean separation of costs

### Test Account

Used for:

* development
* staging
* experiments
* infrastructure validation

Characteristics:

* more permissive deletion policies
* logging and WAF optional
* fast iteration preferred over safety

### Prod Account

Used for:

* real users
* real data
* public traffic

Characteristics:

* strict retention policies
* WAF enabled
* logging enabled
* changes must be intentional

---

## DNS responsibility model

### Root domain

* `emotix.net` is owned by the Management account
* registrar NS records point to Route53 (management)

### Delegation model

| Domain          | Account |
| --------------- | ------- |
| emotix.net      | Prod    |
| test.emotix.net | Test    |

Delegation happens via **NS records** in the management hosted zone.

This allows:

* full autonomy of test/prod
* independent certificates
* clean isolation

---

## Identity & access management

### IAM Identity Center (SSO)

* single identity provider
* no IAM users
* no long‑lived access keys

All humans authenticate via SSO.

---

## Permission sets philosophy

Access is granted via **permission sets**, not directly via IAM policies.

### Core permission sets

| Permission set         | Intended use                 |
| ---------------------- | ---------------------------- |
| AWSAdministratorAccess | Infra bootstrap, emergencies |
| ReadOnlyAccess         | Auditing, support            |
| Custom (future)        | Developers, CI/CD            |

### Environment‑specific assignment

A user may:

* have Admin in **Test**
* have ReadOnly or no access in **Prod**

This is intentional.

---

## CLI & tooling access

### Required discipline

Before any infrastructure command:

```bash
aws sts get-caller-identity
```

Always confirm:

* correct account
* correct role

---

## SSO profile naming convention

Recommended AWS CLI profiles:

```
emotix-mgmt-admin
emotix-test-admin
emotix-prod-admin
```

Clear naming prevents costly mistakes.

---

## Onboarding a new team member (future)

When the team grows:

1. Create user in IAM Identity Center
2. Assign permission sets per account
3. No shared credentials
4. No direct IAM user creation

This process scales linearly without security degradation.

---

## CI/CD access (future)

CI systems should:

* use OIDC federation
* assume dedicated roles
* never use static credentials

CI access is **not human access** and must be isolated.

---

## Why this model scales

This structure:

* matches AWS enterprise best practices
* is used by large SaaS companies
* avoids painful migrations later

Most importantly:

> *You never have to "undo" this design.*

---

## Principles to remember

* accounts are boundaries
* prod is sacred
* test is disposable
* management is control‑plane only
* everything is auditable

---

**This document is as important as infrastructure code.**
