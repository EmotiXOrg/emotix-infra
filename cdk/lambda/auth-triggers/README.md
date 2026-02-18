# Auth Triggers

This folder contains Cognito triggers for identity linking and metadata synchronization.

## Source of truth

- Cognito is the identity source of truth.
- DynamoDB stores profile/auth metadata and audit history.

## Triggers

- `pre-signup/`
  - Trigger: `PreSignUp_ExternalProvider`
  - Purpose: link incoming social identity to existing Cognito native account by normalized email.
  - Rules:
    - require provider email
    - require provider identity details
    - auto-heal native Cognito user from Dynamo metadata when needed

- `post-confirmation/`
  - Trigger: `PostConfirmation_ConfirmSignUp`
  - Purpose:
    - seed `users` metadata row
    - seed first auth method on first confirmation:
      - social provider from `identities` (strict)
      - native `COGNITO` only for explicit native usernames
    - write signup-confirmation audit event
    - emit strict anomaly when provider context is missing

- `post-authentication/`
  - Trigger: `PostAuthentication_Authentication`
  - Purpose:
    - on subsequent successful logins, ensure current social login method exists in metadata
    - resolve canonical account id (native sub for same email)
    - auto-link social provider to native account when possible
    - write audit events for auto-link and strict anomaly cases

## Important behavior

- Linking operations are idempotent; known duplicate/linked exceptions are handled gracefully.
- Canonical account id is used to prevent social/native method split in profile settings.
- Strict mode: no fallback provider inference in post-auth; unresolved external-provider context is logged and alarmed.
