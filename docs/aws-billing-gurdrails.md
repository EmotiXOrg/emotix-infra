# Billing Guardrails (Budgets + Alerts + SCP) for EmotiX AWS Org

## Goal
Prevent unexpected AWS spending while operating mostly inside Free Tier.

Initial budgets:
- Test account (836622697490): **$1/month**
- Prod account (328984697027): **$1/month**

Alerts trigger at **50% / 80% / 100%** of the monthly budget.

This setup is intended to scale later to hundreds/thousands of accounts.

---

## Where to configure (and who pays)
- All billing, budgets, and anomaly detection are configured from the **Management (Payer) account**.
- **Only the Management account pays** (consolidated billing).
- Root user is not used for daily operations (MFA + emergency only).

---

## What is deployed by CDK

### 1) SNS Topic: `billing-alerts`
Central notification channel for:
- AWS Budgets alerts (threshold-based)
- Cost Anomaly Detection notifications

An email subscription is attached:
- aws-management@emotix.net

Later, you can connect SNS to Slack/Teams/PagerDuty/Telegram via Lambda or a webhook bridge.

### 2) AWS Budgets (Actual Spend, Monthly)
Two `COST` budgets (ACTUAL spend, not forecast):
- `test-monthly-actual-1usd` scoped by `LinkedAccount=836622697490`
- `prod-monthly-actual-1usd` scoped by `LinkedAccount=328984697027`

Each budget sends alerts to:
- Email (aws-management@emotix.net)
- SNS topic (billing-alerts)

Thresholds:
- 50% (early warning)
- 80% (almost there)
- 100% (limit reached)

> Note: AWS Budgets are alerting tools, they do **not** automatically stop resources.

### 3) Cost Anomaly Detection
- Monitor type: `DIMENSIONAL` by `SERVICE`
- Subscription: daily anomaly notifications
- Threshold: $1
- Sends to SNS + email

Helps catch “WTF spend” like NAT Gateway, expensive databases, accidental clusters, excessive logs, etc.

### 4) SCP: DenyExpensiveServices (hard prevention)
A Service Control Policy is created and attached directly to:
- Test account (836622697490)
- Prod account (328984697027)

This SCP blocks common high-cost services/actions:
- NAT Gateways + EIP allocation patterns
- RDS / Redshift / ElastiCache / Neptune / Timestream
- OpenSearch/ES, EMR, Glue, Databrew
- SageMaker, Bedrock
- EKS
- AWS Marketplace (avoid paid AMIs/subscriptions)
- Restricts EC2 `RunInstances` to allow-list of cheap instance types:
  - t3.micro, t4g.micro, t3.nano, t4g.nano
- Blocks creating large EBS volumes (> 30 GiB)

> SCPs override IAM: even if a user/role has permissions, these actions will be denied.

---

## How to deploy

### Prerequisites
- Run CDK from the **Management account** credentials.
- Recommended region: `us-east-1`.

### Deploy
```bash
cdk bootstrap
cdk deploy BillingGuardrailsStack
