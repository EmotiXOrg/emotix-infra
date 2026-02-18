# Auth API Lambdas

This folder contains Lambda handlers used by API Gateway auth routes.

## Endpoints and handlers

- `discover/` -> `POST /auth/discover`
  - public endpoint
  - returns allowed next actions and known methods for the entered email
  - relaxed anti-enumeration behavior: always returns `200`

- `methods/` -> `GET /auth/methods`
  - authenticated endpoint (Cognito JWT authorizer)
  - returns linked methods for account settings
  - resolves canonical account by native email account to keep social/native sessions consistent
  - includes `currentlyUsed` marker for current session method

- `set-password/` -> `POST /auth/set-password`
  - authenticated endpoint
  - enables password on existing account (including social-first users)

- `password-setup-start/` -> `POST /auth/password-setup/start`
  - starts verification flow for set-password path

- `password-setup-complete/` -> `POST /auth/password-setup/complete`
  - verifies code and sets password

## Data contract

`GET /auth/methods` returns:

```json
{
  "methods": [
    {
      "method": "password | google | facebook",
      "provider": "COGNITO | Google | Facebook",
      "linkedAt": "ISO timestamp or null",
      "verified": true,
      "currentlyUsed": false
    }
  ]
}
```

