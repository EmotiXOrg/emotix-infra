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
  - Trigger: `PostConfirmation_ConfirmSignUp` and `PostConfirmation_ConfirmForgotPassword`
  - Purpose:
    - seed `users` metadata row
    - seed `METHOD#COGNITO` in methods table
    - write audit event

- `post-authentication/`
  - Trigger: `PostAuthentication_Authentication`
  - Purpose:
    - on successful login, ensure current login method exists in metadata
    - resolve canonical account id (native sub for same email)
    - auto-link social provider to native account when possible
    - write audit event for auto-link

## Important behavior

- Linking operations are idempotent; known duplicate/linked exceptions are handled gracefully.
- Canonical account id is used to prevent social/native method split in profile settings.

