# Billing Guardrails Stack

## Scope and intent

This document describes **exactly how billing protection works** in our AWS Organization.
It is not a tutorial and not a list of options.

The goal of this stack is simple:

- prevent unexpected AWS spending
- stay within (or very close to) Free Tier
- fail early, loudly, and predictably
- make cost-related incidents technically impossible where possible

All configuration described here is **authoritative**.

---

## Where this stack lives

- **AWS account**: Organizations **Management (payer) account**
- **Region**: `us-east-1`
- **Deployment method**: AWS CDK
- **Deployment identity**: GitHub Actions OIDC role in management account

This stack **must never** be deployed from a member account.

---

## What this stack controls

The stack enforces billing safety using three layers:

1. **Budgets** – soft limits with alerts
2. **Cost Anomaly Detection** – unexpected behavior detection
3. **Service Control Policies (SCP)** – hard technical prevention

Each layer exists for a different failure mode.

---

## Account coverage

The stack explicitly targets the following AWS accounts:

| Account | Purpose |
|------|--------|
| Test | Development / testing workloads |
| Prod | Production workloads |

Budgets and SCPs are **scoped per account**, not global.

---

## Budgets (primary spend limits)

### Budget type

- AWS Budgets
- Type: `COST`
- Measurement: **ACTUAL spend** (not forecast)
- Period: **MONTHLY**

Budgets are created **per linked account** using `LinkedAccount` filters.

---

### Budget limits

| Account | Monthly limit |
|------|---------------|
| Test | configurable (default: 1 USD) |
| Prod | configurable (default: 1 USD) |

Hard validation is enforced in code:
- budget must be > 0
- budget must be ≤ 20 USD

Any value outside this range fails synthesis.

---

### Alert thresholds

Each budget emits alerts at the following percentages of the monthly limit:

- 20%
- 50%
- 80%
- 100%

These thresholds are intentionally aggressive to surface issues early.

---

### Budget notifications

Each alert is sent to:

- **Email**: `aws-management@emotix.net`
- **SNS topic**: `billing-alerts`

Budgets do **not** stop resources.
They are an early-warning system only.

---

## SNS topic: `billing-alerts`

A single SNS topic is created for all billing-related alerts.

Current usage:
- receives all AWS Budget notifications
- email subscription only

Important operational note:
- email subscriptions require manual confirmation
- until confirmed, CloudFormation may show `pending confirmation`
- confirmation is required once

SNS exists to allow future integrations (Slack, Telegram, PagerDuty) without redesign.

---

## Cost Anomaly Detection

### Purpose

Budgets detect *how much* is being spent.
They do not explain *why*.

Cost Anomaly Detection exists to catch:
- sudden service activation
- unexpected resource class usage
- configuration mistakes that budgets alone cannot explain

---

### Monitor model

This stack **does not create a custom anomaly monitor**.

It **explicitly uses the AWS-managed default Services monitor**:

- Monitor name: `Default-Services-Monitor`
- Monitor type: AWS services
- Scope: all services

This avoids:
- CloudFormation conflicts
- duplicate monitors
- unsupported “adoption” behavior

The monitor is assumed to already exist in the management account.

---

### Anomaly subscription

A single anomaly subscription is created with:

- Frequency: **DAILY**
- Threshold: **1 USD**
- Subscriber: **EMAIL ONLY**

Important constraint:
- AWS only allows **EMAIL** subscribers for DAILY anomaly subscriptions
- SNS is intentionally not used here

All anomaly notifications go to:
- `aws-management@emotix.net`

---

## Service Control Policy: `DenyExpensiveServices`

### Purpose

SCPs are the **hard stop**.

If budgets and anomalies fail to warn early enough, SCPs make
certain actions **technically impossible**, regardless of IAM permissions.

This SCP is attached directly to:
- Test account
- Prod account

---

### What the SCP denies

#### Networking cost traps
- NAT Gateway creation and deletion
- Elastic IP allocation and association

These are the most common “silent” cost multipliers.

---

#### Managed databases and engines
- RDS
- Redshift
- ElastiCache
- Neptune
- Timestream

All denied completely.

---

#### Search, analytics, and big data platforms
- OpenSearch / Elasticsearch
- EMR
- Glue
- Databrew
- Athena workgroup creation

Denied due to unpredictable and non-linear cost behavior.

---

#### ML / AI services
- SageMaker
- Bedrock

Denied entirely.

---

#### Kubernetes
- EKS (control plane + hidden infra costs)

Denied entirely.

---

#### AWS Marketplace
- Paid AMIs
- Marketplace subscriptions

Denied to prevent accidental billing acceptance.

---

#### EC2 instance restrictions

Only the following instance types are allowed:

- `t3.micro`
- `t4g.micro`
- `t3.nano`
- `t4g.nano`

Any attempt to run any other instance type is denied.

This prevents accidental large compute usage.

---

#### EBS volume size restriction

- Creation of EBS volumes larger than **30 GiB** is denied

This blocks a common hidden cost vector.

---

## Failure model

This stack assumes:

- users will make mistakes
- CI/CD can misconfigure resources
- IAM permissions may be too broad

The guardrails are designed so that:
- mistakes result in **immediate failure**
- costs do **not** silently accumulate
- all failures are observable via email

---

## Deployment characteristics

- single stack
- idempotent
- safe to re-deploy
- no manual steps after initial SNS email confirmation

Rollback behavior:
- if any resource fails, the entire stack rolls back
- this is intentional to avoid partial protection

---

## Design constraints (intentional)

- no per-service budgets
- no fallback monitors
- no multi-region duplication
- no member-account billing configuration
- no auto-remediation logic

This stack exists purely to **protect cost**, not to optimize it.

---

## Summary

This billing stack enforces:

- **visibility** through budgets and anomalies
- **predictability** through strict limits
- **safety** through SCPs
- **centralized control** in the management account

Result:

> It is no longer possible to accidentally generate a large AWS bill.
