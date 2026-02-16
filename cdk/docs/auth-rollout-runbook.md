# Auth Rollout Runbook

This runbook covers deployment, validation, and monitoring for identity linking and auth API flows.

## Scope

- Cognito trigger-based identity linking by verified email
- Auth metadata and audit persistence in DynamoDB
- Auth API endpoints:
  - `POST /auth/discover`
  - `POST /auth/set-password`
  - `GET /auth/methods`

## Deployment Sequence (Test)

1. Deploy identity foundations:
   - `npx cdk deploy EmotixTestAuthStack --require-approval never --profile emotix-test`
2. Deploy auth API:
   - `npx cdk deploy EmotixTestAuthApiStack --require-approval never --profile emotix-test`

## Smoke Validation Checklist

1. Password-first account, then social login with same verified email:
   - Expect same account (no duplicate).
2. Social-first account, then password attempt:
   - Expect frontend guidance to use social method first.
   - After sign-in, set password and verify password login works.
3. Existing account signup attempt:
   - Expect no duplicate account creation.
4. Provider with missing/unverified email:
   - Expect no auto-link.
5. API checks:
   - `POST /auth/discover` returns 200 with action hints.
   - `GET /auth/methods` works for signed-in token.
   - `POST /auth/set-password` requires recent auth token.

## CloudWatch Alarms (Step 5)

Auth stack alarms:

- `PreSignUpTriggerErrorsAlarmName`
- `PostConfirmationTriggerErrorsAlarmName`

Auth API stack alarms:

- `DiscoverAuthFnErrorsAlarmName`
- `SetPasswordAuthFnErrorsAlarmName`
- `GetMethodsAuthFnErrorsAlarmName`
- `AuthApi5xxAlarmName`

Alarm defaults:

- Trigger/Lambda errors: alarm on `>=1` error in `5m`
- API 5xx: alarm on `>=5` responses in `5m`

## Log Queries (CloudWatch Logs Insights)

### Trigger link failures

```sql
fields @timestamp, @message
| filter @message like /Failed linking external provider/
| sort @timestamp desc
| limit 100
```

### Set-password failures

```sql
fields @timestamp, @message
| filter @message like /admin_set_user_password failed/
| sort @timestamp desc
| limit 100
```

## Rollback Strategy

1. If API regression:
   - rollback `EmotixTestAuthApiStack` to previous commit.
2. If trigger regression:
   - rollback `EmotixTestAuthStack` to previous commit.
3. Keep user pool data intact; avoid destructive stack actions in shared environments.

## Phase 2 Backlog (Not in MVP)

1. `POST /auth/unlink-provider` endpoint + UI with "at least one sign-in method" enforcement.
2. Optional `PreTokenGeneration` claims enrichment.
3. Discovery hardening: CAPTCHA/rate limits for abuse scenarios.
4. Audit dashboard for support and risk review.
