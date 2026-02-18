import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

dynamodb = boto3.client("dynamodb")
cognito = boto3.client("cognito-idp")
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
USER_POOL_ID = os.getenv("USER_POOL_ID")


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _provider_to_method(provider: str) -> str:
    mapping = {
        "COGNITO": "password",
        "Google": "google",
        "GOOGLE": "google",
        "Facebook": "facebook",
        "FACEBOOK": "facebook",
    }
    return mapping.get(provider, provider.lower())


def _infer_method_from_username(username: str) -> str | None:
    if not username:
        return None
    if "_" not in username:
        return "password"
    prefix = username.split("_", 1)[0].lower()
    if prefix in {"google", "facebook"}:
        return prefix
    return None


def _methods_from_identities_claim(raw_identities) -> set[str]:
    if not raw_identities:
        return set()
    try:
        identities = json.loads(raw_identities) if isinstance(raw_identities, str) else raw_identities
    except Exception:
        return set()

    methods: set[str] = set()
    if not isinstance(identities, list):
        return methods
    for identity in identities:
        if not isinstance(identity, dict):
            continue
        provider_name = str(identity.get("providerName", "")).strip()
        if not provider_name:
            continue
        methods.add(_provider_to_method(provider_name))
    return methods


def _extract_attr(user: dict, attr_name: str) -> str | None:
    attrs = user.get("Attributes", [])
    hit = next((a for a in attrs if a.get("Name") == attr_name), None)
    return hit.get("Value") if hit else None


def _is_external_provider_user(user: dict) -> bool:
    return str(user.get("UserStatus", "")) == "EXTERNAL_PROVIDER"


def _methods_from_cognito_user(user: dict) -> set[str]:
    methods: set[str] = set()
    username = str(user.get("Username", ""))
    inferred = _infer_method_from_username(username)
    if inferred:
        methods.add(inferred)
    methods |= _methods_from_identities_claim(_extract_attr(user, "identities"))
    return methods


def _load_methods_from_cognito(sub: str) -> set[str]:
    if not USER_POOL_ID or not sub:
        return set()
    try:
        resp = cognito.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'sub = "{sub}"',
            Limit=5,
        )
    except Exception:
        logger.exception("Failed to read users from Cognito for methods fallback")
        return set()

    methods: set[str] = set()
    for user in resp.get("Users", []):
        methods |= _methods_from_cognito_user(user)
    return methods


def _find_users_by_email(email: str) -> list[dict]:
    if not USER_POOL_ID or not email:
        return []
    try:
        resp = cognito.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'email = "{email}"',
            Limit=10,
        )
        return resp.get("Users", [])
    except Exception:
        logger.exception("Failed to read Cognito users by email")
        return []


def _find_users_by_sub(sub: str) -> list[dict]:
    if not USER_POOL_ID or not sub:
        return []
    try:
        resp = cognito.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'sub = "{sub}"',
            Limit=5,
        )
        return resp.get("Users", [])
    except Exception:
        logger.exception("Failed to read Cognito users by sub")
        return []


def _resolve_canonical_sub(token_sub: str, email: str | None) -> str:
    # Access tokens from social flows may omit email. In that case, resolve email from
    # the Cognito user row for this token sub, then pick native account sub by email.
    # This keeps metadata reads stable for both native and social sessions.
    resolved_email = email.strip().lower() if email else None
    if not resolved_email:
        token_users = _find_users_by_sub(token_sub)
        if token_users:
            resolved_email = _extract_attr(token_users[0], "email")
            if isinstance(resolved_email, str):
                resolved_email = resolved_email.strip().lower()

    if not resolved_email:
        return token_sub

    users = _find_users_by_email(resolved_email)
    if not users:
        return token_sub

    native_user = next((u for u in users if not _is_external_provider_user(u)), None)
    if native_user:
        native_sub = _extract_attr(native_user, "sub")
        if native_sub:
            return native_sub
    return token_sub


def handler(event, _context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    sub = claims.get("sub")
    email = claims.get("email")
    if not sub:
        return _response(401, {"message": "Unauthorized"})

    # Always query methods by canonical account key, not raw token sub, otherwise
    # social and native sessions can see different method lists for the same person.
    canonical_sub = _resolve_canonical_sub(sub, email if isinstance(email, str) else None)

    pk = f"USER#{canonical_sub}"
    result = dynamodb.query(
        TableName=USER_AUTH_METHODS_TABLE_NAME,
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": pk}},
    )

    methods_by_name: dict[str, dict] = {}
    for item in result.get("Items", []):
        provider = item.get("provider", {}).get("S", "")
        method = _provider_to_method(provider)
        methods_by_name[method] = {
            "method": method,
            "provider": provider,
            "linkedAt": item.get("linked_at", {}).get("S"),
            "verified": item.get("verified", {}).get("BOOL", False),
        }

    inferred_methods = _methods_from_identities_claim(claims.get("identities"))
    current_username = str(claims.get("username") or claims.get("cognito:username") or "")
    current_method = _infer_method_from_username(current_username)
    # UX helper: mark the login method that produced the current session.
    if current_method:
        inferred_methods.add(current_method)
    if not inferred_methods:
        inferred_methods |= _load_methods_from_cognito(canonical_sub)
    else:
        # Merge token-derived methods with Cognito user-derived methods.
        inferred_methods |= _load_methods_from_cognito(canonical_sub)
    logger.info(
        "Resolved auth methods token_sub=%s canonical_sub=%s: ddb=%s inferred=%s username=%s",
        sub,
        canonical_sub,
        list(methods_by_name.keys()),
        sorted(list(inferred_methods)),
        current_username,
    )

    for method in inferred_methods:
        if method in methods_by_name:
            continue
        provider = method.upper() if method == "password" else method.capitalize()
        methods_by_name[method] = {
            "method": method,
            "provider": provider,
            "linkedAt": None,
            "verified": True,
        }

    methods = list(methods_by_name.values())
    if current_method:
        for method in methods:
            method["currentlyUsed"] = method.get("method") == current_method
    else:
        for method in methods:
            method["currentlyUsed"] = False

    return _response(200, {"methods": methods})
